export interface Env {
  MCP_BEARER: string;
  ACCOUNT_STORE_KEY: string;
  CYPHT_STATE: DurableObjectNamespace;
  MAIL_HOSTNAME?: string;
  MAIL_IMAP_PORT?: string;
  MAIL_SMTP_PORT?: string;
}

export interface Account {
  email: string;
  password: string;
  imap_host: string;
  smtp_host: string;
  display_name?: string;
  signature?: string;
}

export interface PublicAccount {
  email: string;
  imap_host: string;
  smtp_host: string;
  display_name?: string;
  signature?: string;
}
