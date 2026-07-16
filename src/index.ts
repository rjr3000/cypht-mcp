import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import Imap from "imap";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import { z } from "zod";

import { AccountStore, CyphtState } from "./state";
import type { Account, Env, PublicAccount } from "./types";

export { CyphtState };

const VERSION = "2.0.0";
const DEFAULT_MAIL_HOSTNAME = "smtp.rg1.in";
const DEFAULT_IMAP_PORT = 993;
const DEFAULT_SMTP_PORT = 587;

function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errText(message: string, details?: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ error: message, details }, null, 2) }],
  };
}

function publicAccount(account: Account): PublicAccount {
  const { password: _password, ...safe } = account;
  return safe;
}

function configuredMailHost(env: Env): string {
  return env.MAIL_HOSTNAME || DEFAULT_MAIL_HOSTNAME;
}

function parseHost(host: string, defaultPort: number) {
  const withoutScheme = host.replace(/^(ssl|tls|imap|smtp):\/\//, "");
  const separator = withoutScheme.lastIndexOf(":");
  if (separator > -1 && /^\d+$/.test(withoutScheme.slice(separator + 1))) {
    return { hostname: withoutScheme.slice(0, separator), port: Number(withoutScheme.slice(separator + 1)) };
  }
  return { hostname: withoutScheme, port: defaultPort };
}

function validateMailHost(value: string, env: Env, expectedPort: number): string {
  const parsed = parseHost(value, expectedPort);
  if (parsed.hostname !== configuredMailHost(env)) {
    throw new Error(`Only the configured mail host ${configuredMailHost(env)} is allowed.`);
  }
  return `${parsed.hostname}:${parsed.port}`;
}

function imapConnection(account: Account, env: Env) {
  const parsed = parseHost(account.imap_host, Number(env.MAIL_IMAP_PORT || DEFAULT_IMAP_PORT));
  return new Imap({
    user: account.email,
    password: account.password,
    host: parsed.hostname,
    port: parsed.port,
    tls: true,
    tlsOptions: { rejectUnauthorized: true, servername: parsed.hostname },
  });
}

function smtpConnection(account: Account, env: Env) {
  const parsed = parseHost(account.smtp_host, Number(env.MAIL_SMTP_PORT || DEFAULT_SMTP_PORT));
  return createTransport({
    host: parsed.hostname,
    port: parsed.port,
    secure: parsed.port === 465,
    requireTLS: parsed.port !== 465,
    auth: { user: account.email, pass: account.password },
    tls: { rejectUnauthorized: true, servername: parsed.hostname },
  } as never);
}

async function sendEmail(account: Account, args: {
  to: string;
  subject: string;
  body?: string;
  html?: string;
}, env: Env) {
  const transporter = smtpConnection(account, env);
  const signature = account.signature ? `\n\n${account.signature}` : "";
  const text = args.body ? `${args.body}${signature}` : signature;
  const html = args.html
    ? `${args.html}<br><br>${account.signature || ""}`.replace(/\n/g, "<br>")
    : undefined;
  const info = await transporter.sendMail({
    from: `"${account.display_name || account.email}" <${account.email}>`,
    to: args.to,
    subject: args.subject,
    text,
    html,
  });
  return info.messageId;
}

async function listEmails(account: Account, mailbox: string, limit: number, env: Env) {
  const imap = imapConnection(account, env);
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    let settled = false;
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    imap.once("error", fail);
    imap.once("ready", () => {
      imap.openBox(mailbox, true, (error, box) => {
        if (error) {
          imap.end();
          return fail(error);
        }
        const total = box.messages.total;
        const start = Math.max(1, total - limit + 1);
        const range = total === 0 ? "1:0" : `${start}:${total}`;
        const fetcher = imap.seq.fetch(range, {
          bodies: "HEADER.FIELDS (FROM SUBJECT DATE)",
          struct: false,
        });
        fetcher.on("message", (message) => {
          const item: Record<string, unknown> = {};
          message.on("body", (stream) => {
            let buffer = "";
            stream.on("data", (chunk) => (buffer += chunk.toString("utf8")));
            stream.on("end", () => {
              for (const line of buffer.split(/\r?\n/)) {
                const separator = line.indexOf(":");
                if (separator > 0) item[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
              }
            });
          });
          message.on("attributes", (attributes) => (item.uid = attributes.uid));
          message.on("end", () => messages.push(item));
        });
        fetcher.once("error", (fetchError) => {
          imap.end();
          fail(fetchError);
        });
        fetcher.once("end", () => {
          imap.end();
          settled = true;
          resolve(messages);
        });
      });
    });
    imap.connect();
  });
}

async function searchEmails(account: Account, mailbox: string, query: string, env: Env) {
  const imap = imapConnection(account, env);
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    imap.once("error", fail);
    imap.once("ready", () => {
      imap.openBox(mailbox, true, (error) => {
        if (error) {
          imap.end();
          return fail(error);
        }
        imap.search([["OR", ["SUBJECT", query], ["FROM", query]]] as never, (searchError, uids) => {
          if (searchError) {
            imap.end();
            return fail(searchError);
          }
          if (!uids.length) {
            imap.end();
            settled = true;
            return resolve([]);
          }
          const results: Record<string, unknown>[] = [];
          const fetcher = imap.fetch(uids, {
            bodies: "HEADER.FIELDS (FROM SUBJECT DATE)",
            struct: false,
          });
          fetcher.on("message", (message) => {
            const item: Record<string, unknown> = {};
            message.on("body", (stream) => {
              let buffer = "";
              stream.on("data", (chunk) => (buffer += chunk.toString("utf8")));
              stream.on("end", () => {
                for (const line of buffer.split(/\r?\n/)) {
                  const separator = line.indexOf(":");
                  if (separator > 0) item[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
                }
              });
            });
            message.on("attributes", (attributes) => (item.uid = attributes.uid));
            message.on("end", () => results.push(item));
          });
          fetcher.once("error", (fetchError) => {
            imap.end();
            fail(fetchError);
          });
          fetcher.once("end", () => {
            imap.end();
            settled = true;
            resolve(results);
          });
        });
      });
    });
    imap.connect();
  });
}

async function viewEmail(account: Account, mailbox: string, uid: string, env: Env) {
  const imap = imapConnection(account, env);
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    imap.once("error", fail);
    imap.once("ready", () => {
      imap.openBox(mailbox, true, (error) => {
        if (error) {
          imap.end();
          return fail(error);
        }
        const fetcher = imap.fetch(uid, { bodies: "" });
        let buffer = new Uint8Array();
        fetcher.on("message", (message) => {
          message.on("body", (stream) => {
            stream.on("data", (chunk) => {
              const next = new Uint8Array(buffer.length + chunk.length);
              next.set(buffer);
              next.set(chunk, buffer.length);
              buffer = next;
            });
          });
        });
        fetcher.once("error", (fetchError) => {
          imap.end();
          fail(fetchError);
        });
        fetcher.once("end", async () => {
          imap.end();
          try {
            const parsed = await simpleParser(buffer);
            resolve({
              from: parsed.from?.text,
              to: parsed.to?.text,
              subject: parsed.subject,
              date: parsed.date,
              text: parsed.text,
              html: parsed.html,
              attachments: parsed.attachments.map((attachment) => ({
                filename: attachment.filename,
                contentType: attachment.contentType,
                size: attachment.size,
              })),
            });
            settled = true;
          } catch (parseError) {
            fail(parseError);
          }
        });
      });
    });
    imap.connect();
  });
}

async function deleteEmail(account: Account, mailbox: string, uid: string, env: Env) {
  const imap = imapConnection(account, env);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    imap.once("error", fail);
    imap.once("ready", () => {
      imap.openBox(mailbox, false, (error) => {
        if (error) {
          imap.end();
          return fail(error);
        }
        imap.addFlags(uid, "\\Deleted", (flagError) => {
          if (flagError) {
            imap.end();
            return fail(flagError);
          }
          imap.expunge((expungeError) => {
            imap.end();
            if (expungeError) return fail(expungeError);
            settled = true;
            resolve();
          });
        });
      });
    });
    imap.connect();
  });
}

function withStreamableAccept(request: Request): Request {
  const accept = request.headers.get("accept") ?? "";
  if (accept.includes("application/json") && accept.includes("text/event-stream")) return request;
  const headers = new Headers(request.headers);
  const values = accept.split(",").map((value) => value.trim()).filter(Boolean);
  if (!values.includes("application/json")) values.push("application/json");
  if (!values.includes("text/event-stream")) values.push("text/event-stream");
  headers.set("accept", values.join(", "));
  return new Request(request, { headers });
}

function authFailure(request: Request, env: Env): Response | null {
  const authorization = request.headers.get("authorization") ?? "";
  if (!env.MCP_BEARER || authorization !== `Bearer ${env.MCP_BEARER}`) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="cypht-mcp"' },
    });
  }
  return null;
}

function buildServer(env: Env) {
  const store = new AccountStore(env);
  const server = new McpServer({ name: "cypht-mcp", version: VERSION });

  server.tool(
    "help",
    "Cypht email MCP documentation and safety guidance.",
    { topic: z.string().default("index") },
    async ({ topic }) => {
      if (topic !== "index") return errText(`Unknown help topic: ${topic}`);
      return {
        content: [{
          type: "text",
          text: [
            "cypht-mcp v2 — email operations over IMAP/SMTP.",
            "Tools: add_account, set_profile, list_accounts, send_email, list_emails, view_email, search_emails, delete_email.",
            "Accounts are encrypted in a Durable Object and mailbox passwords are never returned.",
            "send_email sends through the configured SMTP server; list/view/search/delete use IMAP.",
            "delete_email permanently expunges the selected message. Confirm the mailbox and UID before calling it.",
          ].join("\\n"),
        }],
      };
    },
  );

  server.tool(
    "meta",
    "Server identity and account-store status.",
    { action: z.enum(["whoami", "health", "list_accounts"]).default("whoami") },
    async ({ action }) => {
      if (action === "health") return okJson({ ok: true, server: "cypht-mcp", version: VERSION });
      if (action === "list_accounts") {
        const accounts = await store.list();
        return okJson({ accounts: accounts.map(publicAccount) });
      }
      return okJson({
        server: "cypht-mcp",
        version: VERSION,
        transport: "Streamable HTTP",
        mail_host: configuredMailHost(env),
        tools: ["add_account", "set_profile", "list_accounts", "send_email", "list_emails", "view_email", "search_emails", "delete_email"],
      });
    },
  );

  server.tool(
    "add_account",
    "Persist an encrypted IMAP/SMTP mailbox account for email operations.",
    {
      email: z.string().email(),
      password: z.string().min(1),
      imap_host: z.string().optional(),
      smtp_host: z.string().optional(),
      display_name: z.string().optional(),
    },
    async (args) => {
      try {
        const imapHost = validateMailHost(args.imap_host || `ssl://${configuredMailHost(env)}:${env.MAIL_IMAP_PORT || DEFAULT_IMAP_PORT}`, env, DEFAULT_IMAP_PORT);
        const smtpHost = validateMailHost(args.smtp_host || `tls://${configuredMailHost(env)}:${env.MAIL_SMTP_PORT || DEFAULT_SMTP_PORT}`, env, DEFAULT_SMTP_PORT);
        await store.put({
          email: args.email,
          password: args.password,
          imap_host: `ssl://${imapHost}`,
          smtp_host: `tls://${smtpHost}`,
          display_name: args.display_name,
        });
        return okJson({ ok: true, email: args.email });
      } catch (error) {
        return errText("Unable to add account", (error as Error).message);
      }
    },
  );

  server.tool(
    "set_profile",
    "Update an account display name and/or signature.",
    {
      email: z.string().email(),
      display_name: z.string().optional(),
      signature: z.string().optional(),
    },
    async (args) => {
      try {
        const account = await store.get(args.email);
        if (!account) return errText("Account not found", { email: args.email });
        if (args.display_name !== undefined) account.display_name = args.display_name;
        if (args.signature !== undefined) account.signature = args.signature;
        await store.put(account);
        return okJson({ ok: true, account: publicAccount(account) });
      } catch (error) {
        return errText("Unable to update profile", (error as Error).message);
      }
    },
  );

  server.tool("list_accounts", "List configured mailbox accounts without passwords.", {}, async () => {
    try {
      return okJson({ accounts: (await store.list()).map(publicAccount) });
    } catch (error) {
      return errText("Unable to list accounts", (error as Error).message);
    }
  });

  server.tool(
    "send_email",
    "Send an email through the configured SMTP server.",
    {
      from: z.string().email(),
      to: z.string().email(),
      subject: z.string().min(1),
      body: z.string().optional(),
      html: z.string().optional(),
    },
    async (args) => {
      try {
        const account = await store.get(args.from);
        if (!account) return errText("Account not found", { email: args.from });
        return okJson({ ok: true, messageId: await sendEmail(account, args, env) });
      } catch (error) {
        return errText("Unable to send email", (error as Error).message);
      }
    },
  );

  server.tool(
    "list_emails",
    "List the newest message headers in an IMAP mailbox.",
    {
      email: z.string().email(),
      mailbox: z.string().default("INBOX"),
      limit: z.number().int().min(1).max(100).default(10),
    },
    async (args) => {
      try {
        const account = await store.get(args.email);
        if (!account) return errText("Account not found", { email: args.email });
        return okJson({ emails: await listEmails(account, args.mailbox, args.limit, env) });
      } catch (error) {
        return errText("Unable to list emails", (error as Error).message);
      }
    },
  );

  server.tool(
    "view_email",
    "Fetch a full message by IMAP UID, including text, HTML, and attachment metadata.",
    {
      email: z.string().email(),
      mailbox: z.string().default("INBOX"),
      uid: z.string().min(1),
    },
    async (args) => {
      try {
        const account = await store.get(args.email);
        if (!account) return errText("Account not found", { email: args.email });
        return okJson({ email: await viewEmail(account, args.mailbox, args.uid, env) });
      } catch (error) {
        return errText("Unable to view email", (error as Error).message);
      }
    },
  );

  server.tool(
    "search_emails",
    "Search a mailbox by subject or sender and return matching message headers.",
    {
      email: z.string().email(),
      mailbox: z.string().default("INBOX"),
      query: z.string().min(1),
    },
    async (args) => {
      try {
        const account = await store.get(args.email);
        if (!account) return errText("Account not found", { email: args.email });
        return okJson({ emails: await searchEmails(account, args.mailbox, args.query, env) });
      } catch (error) {
        return errText("Unable to search emails", (error as Error).message);
      }
    },
  );

  server.tool(
    "delete_email",
    "Permanently delete and expunge an email by IMAP UID.",
    {
      email: z.string().email(),
      mailbox: z.string().default("INBOX"),
      uid: z.string().min(1),
    },
    async (args) => {
      try {
        const account = await store.get(args.email);
        if (!account) return errText("Account not found", { email: args.email });
        await deleteEmail(account, args.mailbox, args.uid, env);
        return okJson({ ok: true, deleted: args.uid });
      } catch (error) {
        return errText("Unable to delete email", (error as Error).message);
      }
    },
  );

  return server;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(`cypht-mcp v${VERSION} — POST /mcp\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (url.pathname !== "/mcp" && !url.pathname.startsWith("/mcp/")) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method === "GET" && !request.headers.get("mcp-session-id")) {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const denied = authFailure(request, env);
    if (denied) return denied;
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = buildServer(env);
    await server.connect(transport);
    return transport.handleRequest(withStreamableAccept(request));
  },
};
