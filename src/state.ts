import type { Account, Env } from "./types";

interface StoredAccount {
  email: string;
  value: string;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptAccount(account: Account, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(account)),
  );
  return JSON.stringify({ iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) });
}

async function decryptAccount(value: string, secret: string): Promise<Account> {
  const envelope = JSON.parse(value) as { iv: string; ciphertext: string };
  const key = await encryptionKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: decodeBase64(envelope.iv) },
    key,
    decodeBase64(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as Account;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function accountStorageKey(email: string): string {
  return `account:${encodeURIComponent(email)}`;
}

export class AccountStore {
  private readonly stub: DurableObjectStub;
  private readonly secret: string;

  constructor(env: Env) {
    const id = env.CYPHT_STATE.idFromName("accounts");
    this.stub = env.CYPHT_STATE.get(id);
    this.secret = env.ACCOUNT_STORE_KEY;
  }

  private async request(body: Record<string, unknown>): Promise<unknown> {
    const response = await this.stub.fetch("https://cypht-state.internal/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }

  async get(email: string): Promise<Account | undefined> {
    const result = (await this.request({ action: "get", key: accountStorageKey(email) })) as {
      value?: string;
    };
    return result.value ? decryptAccount(result.value, this.secret) : undefined;
  }

  async list(): Promise<Account[]> {
    const result = (await this.request({ action: "list" })) as { accounts: StoredAccount[] };
    return Promise.all(result.accounts.map((account) => decryptAccount(account.value, this.secret)));
  }

  async put(account: Account): Promise<void> {
    await this.request({
      action: "put",
      key: accountStorageKey(account.email),
      value: await encryptAccount(account, this.secret),
    });
  }
}

export class CyphtState {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    const body = (await request.json()) as { action?: string; key?: string; value?: string };
    if (body.action === "get" && body.key) {
      return jsonResponse({ value: (await this.state.storage.get<string>(body.key)) ?? null });
    }
    if (body.action === "put" && body.key && body.value) {
      await this.state.storage.put(body.key, body.value);
      return jsonResponse({ ok: true });
    }
    if (body.action === "list") {
      const entries = await this.state.storage.list<string>({ prefix: "account:" });
      return jsonResponse({
        accounts: Array.from(entries, ([key, value]) => ({ email: decodeURIComponent(key.slice(8)), value })),
      });
    }
    return jsonResponse({ error: "Invalid state request" }, 400);
  }
}
