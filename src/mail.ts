import { connect } from "cloudflare:sockets";
import { Buffer } from "node:buffer";
import { simpleParser } from "mailparser";

import type { Account, Env } from "./types";

const DEFAULT_HOST = "smtp.rg1.in";
const IMAP_PORT = 993;
const SMTP_PORT = 465;

function hostFor(env: Env): string {
  return env.MAIL_HOSTNAME || DEFAULT_HOST;
}

function encodeBase64(value: string): string {
  return btoa(value);
}

function quoteImap(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function cleanHeader(value: string): string {
  return value.replace(/[\r\n]/g, " ").trim();
}

function bytesToText(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function concatBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

class TcpLineClient {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  constructor(private readonly socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async write(value: string | Uint8Array): Promise<void> {
    await this.writer.write(typeof value === "string" ? new TextEncoder().encode(value) : value);
  }

  private async fill(minimum: number): Promise<void> {
    while (this.buffer.length < minimum) {
      const chunk = await this.reader.read();
      if (chunk.done) throw new Error("Mail server closed the connection.");
      this.buffer = concatBytes(this.buffer, chunk.value);
    }
  }

  async readLine(): Promise<string> {
    while (true) {
      const end = this.buffer.findIndex((byte, index) => byte === 10 && index > 0 && this.buffer[index - 1] === 13);
      if (end >= 0) {
        const line = bytesToText(this.buffer.slice(0, end - 1));
        this.buffer = this.buffer.slice(end + 1);
        return line;
      }
      await this.fill(this.buffer.length + 1);
    }
  }

  async readBytes(length: number): Promise<Uint8Array> {
    await this.fill(length);
    const bytes = this.buffer.slice(0, length);
    this.buffer = this.buffer.slice(length);
    return bytes;
  }

  async discardCrlf(): Promise<void> {
    await this.fill(2);
    if (this.buffer[0] === 13 && this.buffer[1] === 10) this.buffer = this.buffer.slice(2);
  }

  async close(): Promise<void> {
    try { await this.writer.close(); } catch { /* socket close below */ }
    try { await this.reader.cancel(); } catch { /* already closed */ }
    await this.socket.close();
  }
}

interface ImapResponse {
  line: string;
  literal?: Uint8Array;
}

class ImapClient {
  private tag = 0;
  private transport!: TcpLineClient;

  async connect(account: Account, env: Env): Promise<void> {
    const socket = connect({ hostname: hostFor(env), port: IMAP_PORT }, { secureTransport: "on", allowHalfOpen: false });
    await socket.opened;
    this.transport = new TcpLineClient(socket);
    await this.transport.readLine();
    await this.command(`LOGIN ${quoteImap(account.email)} ${quoteImap(account.password)}`);
  }

  private async command(command: string): Promise<ImapResponse[]> {
    const tag = `A${String(++this.tag).padStart(4, "0")}`;
    await this.transport.write(`${tag} ${command}\r\n`);
    const responses: ImapResponse[] = [];
    while (true) {
      const line = await this.transport.readLine();
      const literalMatch = line.match(/\{(\d+)\}$/);
      let literal: Uint8Array | undefined;
      if (literalMatch) {
        literal = await this.transport.readBytes(Number(literalMatch[1]));
        await this.transport.discardCrlf();
      }
      responses.push({ line, literal });
      if (line.startsWith(`${tag} `)) {
        if (!/^(OK|PREAUTH)\b/.test(line.slice(tag.length + 1))) {
          throw new Error(`IMAP command failed: ${line}`);
        }
        return responses;
      }
    }
  }

  async select(mailbox: string, readOnly: boolean): Promise<void> {
    await this.command(`${readOnly ? "EXAMINE" : "SELECT"} ${quoteImap(mailbox)}`);
  }

  async search(criteria: string): Promise<string[]> {
    const responses = await this.command(`UID SEARCH ${criteria}`);
    const line = responses.find((response) => response.line.startsWith("* SEARCH "))?.line || "* SEARCH";
    return line.slice("* SEARCH".length).trim().split(/\s+/).filter(Boolean);
  }

  async fetchHeaders(uids: string[]): Promise<Record<string, unknown>[]> {
    if (!uids.length) return [];
    const responses = await this.command(`UID FETCH ${uids.join(",")} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
    return responses.filter((response) => response.literal).map((response) => ({
      ...parseHeaders(response.literal!),
      uid: response.line.match(/\bUID\s+(\d+)/i)?.[1],
    }));
  }

  async fetchMessage(uid: string): Promise<Uint8Array> {
    const responses = await this.command(`UID FETCH ${uid} BODY.PEEK[]`);
    const literal = responses.find((response) => response.literal)?.literal;
    if (!literal) throw new Error(`Message UID ${uid} was not found.`);
    return literal;
  }

  async delete(uid: string): Promise<void> {
    await this.command(`UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`);
    await this.command(`UID EXPUNGE ${uid}`);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}

function parseHeaders(bytes: Uint8Array): Record<string, string> {
  const unfolded = bytesToText(bytes).replace(/\r?\n[ \t]+/g, " ");
  const result: Record<string, string> = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) result[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return result;
}

async function withImap<T>(account: Account, env: Env, callback: (client: ImapClient) => Promise<T>): Promise<T> {
  const client = new ImapClient();
  try {
    await client.connect(account, env);
    return await callback(client);
  } finally {
    await client.close();
  }
}

export async function listEmails(account: Account, mailbox: string, limit: number, env: Env) {
  return withImap(account, env, async (client) => {
    await client.select(mailbox, true);
    const uids = await client.search("ALL");
    return client.fetchHeaders(uids.slice(Math.max(0, uids.length - limit)));
  });
}

export async function searchEmails(account: Account, mailbox: string, query: string, env: Env) {
  return withImap(account, env, async (client) => {
    await client.select(mailbox, true);
    const safeQuery = quoteImap(query);
    const uids = await client.search(`OR SUBJECT ${safeQuery} FROM ${safeQuery}`);
    return client.fetchHeaders(uids);
  });
}

export async function viewEmail(account: Account, mailbox: string, uid: string, env: Env) {
  return withImap(account, env, async (client) => {
    await client.select(mailbox, true);
    const parsed = await simpleParser(Buffer.from(await client.fetchMessage(uid)));
    return {
      from: addressText(parsed.from),
      to: addressText(parsed.to),
      subject: parsed.subject,
      date: parsed.date,
      text: parsed.text,
      html: parsed.html,
      attachments: parsed.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.size,
      })),
    };
  });
}

export async function deleteEmail(account: Account, mailbox: string, uid: string, env: Env) {
  return withImap(account, env, async (client) => {
    await client.select(mailbox, false);
    await client.delete(uid);
  });
}

function addressText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => addressText(item)).filter(Boolean).join(", ") || undefined;
  }
  return value && typeof value === "object" && "text" in value ? String(value.text) : undefined;
}

class SmtpClient {
  public transport!: TcpLineClient;

  async connect(account: Account, env: Env): Promise<void> {
    const socket = connect({ hostname: hostFor(env), port: SMTP_PORT }, { secureTransport: "on", allowHalfOpen: false });
    await socket.opened;
    this.transport = new TcpLineClient(socket);
    await this.expect(220);
    await this.command(`EHLO ${hostFor(env)}`, 250);
    await this.command("AUTH LOGIN", 334);
    await this.command(encodeBase64(account.email), 334);
    await this.command(encodeBase64(account.password), 235);
  }

  private async expect(code: number): Promise<string> {
    let last = "";
    while (true) {
      last = await this.transport.readLine();
      if (last.startsWith(`${code} `)) return last;
      if (/^\d{3} /.test(last)) throw new Error(`SMTP command failed: ${last}`);
    }
  }

  private async command(value: string, code: number): Promise<string> {
    await this.transport.write(`${value}\r\n`);
    return this.expect(code);
  }

  async send(account: Account, args: { to: string; subject: string; body?: string; html?: string }, env: Env): Promise<string> {
    await this.connect(account, env);
    await this.command(`MAIL FROM:<${account.email}>`, 250);
    await this.command(`RCPT TO:<${args.to}>`, 250);
    const text = args.body || "";
    const signature = account.signature ? `\r\n\r\n${account.signature}` : "";
    const boundary = `cypht-${crypto.randomUUID()}`;
    const body = args.html
      ? [
          `From: ${cleanHeader(account.display_name || account.email)} <${account.email}>`,
          `To: ${args.to}`,
          `Subject: ${cleanHeader(args.subject)}`,
          "MIME-Version: 1.0",
          `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
          "",
          `--${boundary}`,
          "Content-Type: text/plain; charset=UTF-8",
          "",
          text + signature,
          `--${boundary}`,
          "Content-Type: text/html; charset=UTF-8",
          "",
          args.html + (account.signature ? `<br><br>${account.signature.replace(/\n/g, "<br>")}` : ""),
          `--${boundary}--`,
        ].join("\r\n")
      : [
          `From: ${cleanHeader(account.display_name || account.email)} <${account.email}>`,
          `To: ${args.to}`,
          `Subject: ${cleanHeader(args.subject)}`,
          "Content-Type: text/plain; charset=UTF-8",
          "",
          text + signature,
        ].join("\r\n");
    await this.command("DATA", 354);
    await this.transport.write(body.replace(/^\./gm, "..").replace(/\r?\n/g, "\r\n") + "\r\n.\r\n");
    await this.expect(250);
    await this.command("QUIT", 221);
    await this.transport.close();
    return `<${crypto.randomUUID()}@${hostFor(env)}>`;
  }
}

export async function sendEmail(account: Account, args: { to: string; subject: string; body?: string; html?: string }, env: Env) {
  const client = new SmtpClient();
  try {
    return await client.send(account, args, env);
  } catch (error) {
    try { await client.transport?.close(); } catch { /* best effort */ }
    throw error;
  }
}
