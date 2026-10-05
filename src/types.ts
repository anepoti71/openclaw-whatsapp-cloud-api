// ---------------------------------------------------------------------------
// WhatsApp Cloud API — Type Definitions
// ---------------------------------------------------------------------------

/**
 * A reference to a value held in OpenClaw's secret store instead of plaintext.
 * Mirrors OpenClaw's SecretRef shape, e.g.
 *   { source: "store", provider: "default", id: "WHATSAPP_CLOUD_ACCESS_TOKEN" }
 */
export interface SecretRef {
  source: "env" | "file" | "exec" | "store";
  provider: string;
  id: string;
}

/** A secret config value: either a literal string or a SecretRef. */
export type SecretInput = string | SecretRef;

/** Plugin configuration (stored under channels.whatsapp-cloud in openclaw.json) */
export interface WhatsAppCloudConfig {
  enabled: boolean;
  phoneNumberId: string;
  businessAccountId: string;
  /** Resolved access token (empty until SecretRefs are resolved; see _rawAccessToken). */
  accessToken: string;
  /** Resolved app secret (empty until SecretRefs are resolved; see _rawAppSecret). */
  appSecret: string;
  verifyToken: string;
  webhookPort: number;
  webhookPath: string;
  apiVersion: string;
  dmPolicy: "open" | "allowlist";
  allowFrom: string[];
  sendReadReceipts: boolean;
  /**
   * When true (default), inbound media (voice notes, images, video, documents)
   * is downloaded and attached to the agent turn so OpenClaw can transcribe
   * audio and read images. Set false to deliver only placeholder text.
   */
  downloadInboundMedia: boolean;
  /**
   * When true (default), OpenClaw's own service/fallback notices (for example
   * "⚠️ OpenClaw couldn't produce or deliver a reply...") are never relayed to the
   * WhatsApp user. Set false to let them through. See isServiceNotice() in api.ts.
   */
  suppressServiceNotices: boolean;
  /**
   * Optional user-facing text sent in place of a suppressed service notice. When
   * unset, the notice is dropped silently (no message reaches the user).
   */
  serviceNoticeReplacement?: string;
  /** Raw accessToken value as configured (string or SecretRef) before resolution. */
  _rawAccessToken?: SecretInput;
  /** Raw appSecret value as configured (string or SecretRef) before resolution. */
  _rawAppSecret?: SecretInput;
}

/** Defaults applied when config values are missing */
export const CONFIG_DEFAULTS: Partial<WhatsAppCloudConfig> = {
  enabled: true,
  verifyToken: "openclaw-wa-cloud-verify",
  webhookPort: 3100,
  webhookPath: "/webhook/whatsapp-cloud",
  apiVersion: "v21.0",
  dmPolicy: "open",
  allowFrom: [],
  sendReadReceipts: true,
  downloadInboundMedia: true,
  suppressServiceNotices: true,
};

// ---------------------------------------------------------------------------
// Meta Webhook Payload (inbound)
// ---------------------------------------------------------------------------

export interface WebhookPayload {
  object: "whatsapp_business_account";
  entry: WebhookEntry[];
}

export interface WebhookEntry {
  id: string;
  changes: WebhookChange[];
}

export interface WebhookChange {
  value: WebhookValue;
  field: string;
}

export interface WebhookValue {
  messaging_product: "whatsapp";
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WebhookContact[];
  messages?: IncomingMessage[];
  statuses?: MessageStatus[];
  errors?: WebhookError[];
}

export interface WebhookContact {
  profile: { name: string };
  wa_id: string;
}

export interface IncomingMessage {
  from: string;
  id: string;
  timestamp: string;
  type: MessageType;
  text?: { body: string };
  image?: MediaObject;
  audio?: MediaObject;
  video?: MediaObject;
  document?: MediaObject & { filename?: string };
  sticker?: MediaObject;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: Array<{ name: { formatted_name: string }; phones?: Array<{ phone: string }> }>;
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: { text: string; payload: string };
  context?: {
    from: string;
    id: string;
    referred_product?: { catalog_id: string; product_retailer_id: string };
  };
}

export type MessageType =
  | "text"
  | "image"
  | "audio"
  | "video"
  | "document"
  | "sticker"
  | "location"
  | "contacts"
  | "interactive"
  | "button"
  | "reaction"
  | "order"
  | "unknown";

export interface MediaObject {
  id: string;
  mime_type: string;
  sha256?: string;
  caption?: string;
}

export interface MessageStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  errors?: WebhookError[];
}

export interface WebhookError {
  code: number;
  title: string;
  message: string;
  error_data?: { details: string };
}

// ---------------------------------------------------------------------------
// Meta Cloud API — Outbound message types
// ---------------------------------------------------------------------------

export interface SendTextRequest {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "text";
  text: { preview_url: boolean; body: string };
}

export interface SendTemplateRequest {
  messaging_product: "whatsapp";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: string };
    components?: TemplateComponent[];
  };
}

export interface TemplateComponent {
  type: "header" | "body" | "button";
  parameters: Array<{
    type: "text" | "currency" | "date_time" | "image" | "document" | "video";
    text?: string;
    image?: { link: string };
  }>;
}

export interface SendInteractiveRequest {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: InteractiveMessage;
}

export interface InteractiveMessage {
  type: "button" | "list";
  header?: { type: "text"; text: string };
  body: { text: string };
  footer?: { text: string };
  action: InteractiveAction;
}

export interface InteractiveAction {
  // Button type
  buttons?: Array<{
    type: "reply";
    reply: { id: string; title: string };
  }>;
  // List type
  button?: string;
  sections?: Array<{
    title: string;
    rows: Array<{
      id: string;
      title: string;
      description?: string;
    }>;
  }>;
}

export interface SendMediaRequest {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "image" | "audio" | "video" | "document";
  image?: { link?: string; id?: string; caption?: string };
  audio?: { link?: string; id?: string };
  video?: { link?: string; id?: string; caption?: string };
  document?: { link?: string; id?: string; caption?: string; filename?: string };
}

// ---------------------------------------------------------------------------
// API response types
// ---------------------------------------------------------------------------

export interface SendMessageResponse {
  messaging_product: "whatsapp";
  contacts: Array<{ input: string; wa_id: string }>;
  messages: Array<{ id: string; message_status?: string }>;
}

export interface MediaUrlResponse {
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  id: string;
  messaging_product: "whatsapp";
}

export interface ApiErrorResponse {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id: string;
  };
}

// ---------------------------------------------------------------------------
// Plugin internal types
// ---------------------------------------------------------------------------

export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug: (msg: string) => void;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}
