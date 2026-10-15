// ---------------------------------------------------------------------------
// Meta WhatsApp Cloud API Client
// Handles all outbound communication with graph.facebook.com
// ---------------------------------------------------------------------------

import type {
  WhatsAppCloudConfig,
  SendResult,
  SendMessageResponse,
  SendTextRequest,
  SendTemplateRequest,
  SendInteractiveRequest,
  SendMediaRequest,
  InteractiveMessage,
  TemplateComponent,
  MediaUrlResponse,
  ApiErrorResponse,
  Logger,
} from "./types.js";

const API_BASE = "https://graph.facebook.com";

function apiUrl(config: WhatsAppCloudConfig, path: string): string {
  return `${API_BASE}/${config.apiVersion}/${path}`;
}

function headers(config: WhatsAppCloudConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.accessToken}`,
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Retry on transient errors
// ---------------------------------------------------------------------------
// Only rate limits and server errors are retried. Network errors are NOT: the
// request may have reached Meta, and resending would duplicate the message.
// ---------------------------------------------------------------------------

/** Retry policy; mutable so tests can drop the delay. */
export const retryPolicy = { maxAttempts: 3, baseDelayMs: 1000 };

const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);
// 4 / 80007 / 130429: app or account throughput limit; 131056: pair rate limit.
const RETRYABLE_META_CODES = new Set([4, 80007, 130429, 131056]);

function isRetryable(status: number, err: ApiErrorResponse | undefined): boolean {
  if (RETRYABLE_HTTP.has(status)) return true;
  const code = err?.error?.code;
  return code !== undefined && RETRYABLE_META_CODES.has(code);
}

/**
 * fetch with retry on transient HTTP errors. Returns the final response; the
 * parsed error body is returned alongside when the response is not ok.
 */
async function fetchWithRetry(
  url: string,
  init: () => RequestInit,
  log: Logger
): Promise<{ response: Response; err?: ApiErrorResponse }> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, init());
    if (response.ok) return { response };

    const err = (await response.json().catch(() => ({}))) as ApiErrorResponse;
    if (attempt >= retryPolicy.maxAttempts || !isRetryable(response.status, err)) {
      return { response, err };
    }
    const delay = retryPolicy.baseDelayMs * 2 ** (attempt - 1);
    log.warn(
      `[whatsapp-cloud] Transient API error (HTTP ${response.status}${err?.error?.code ? `, code ${err.error.code}` : ""}), retry ${attempt}/${retryPolicy.maxAttempts - 1} in ${delay}ms`
    );
    await new Promise((r) => setTimeout(r, delay));
  }
}

// ---------------------------------------------------------------------------
// Core send function
// ---------------------------------------------------------------------------

/** Per-send options shared by message senders. */
export interface SendOptions {
  /** WhatsApp message id to quote (shown as a reply bubble). */
  replyToId?: string | null;
}

/** Add the reply `context` to a message body when quoting a message. */
function withContext<T extends object>(body: T, opts?: SendOptions): T {
  return opts?.replyToId ? { ...body, context: { message_id: opts.replyToId } } : body;
}

async function sendRequest(
  config: WhatsAppCloudConfig,
  body: Record<string, unknown>,
  log: Logger
): Promise<SendResult> {
  const url = apiUrl(config, `${config.phoneNumberId}/messages`);

  try {
    const { response, err } = await fetchWithRetry(
      url,
      () => ({ method: "POST", headers: headers(config), body: JSON.stringify(body) }),
      log
    );

    if (!response.ok) {
      const errorMsg =
        err?.error?.message ?? `HTTP ${response.status} ${response.statusText}`;
      log.error(`[whatsapp-cloud] API error: ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }

    const data = (await response.json()) as SendMessageResponse;
    return { ok: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`[whatsapp-cloud] Network error: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}

// ---------------------------------------------------------------------------
// Service-notice suppression
// ---------------------------------------------------------------------------

/**
 * Stable leading markers of OpenClaw's own service/fallback notices. These are
 * emitted by the core auto-reply dispatcher (not by the agent) when a turn fails
 * to produce a visible reply or the session queue is full, and they are plain
 * text by the time they reach this channel's outbound. We match on a stable
 * prefix so a trailing "Reference: <runId>." or minor wording changes still hit.
 * Keep entries generic (no engagement/client specifics) and easy to extend.
 */
const SERVICE_NOTICE_PREFIXES: readonly string[] = [
  "⚠️ OpenClaw couldn't produce or deliver a reply",
  "This message was not queued because the session queue is full",
];

/** True when `text` is an OpenClaw service/fallback notice, not an agent reply. */
export function isServiceNotice(text: string): boolean {
  const trimmed = text.trimStart();
  return SERVICE_NOTICE_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Cron/agent deliveries append a run-inspection footer ("Inspect: https://…/run/…")
 * aimed at the operator, never at the end user. Strip a trailing Inspect line so it
 * never reaches a WhatsApp recipient.
 */
// Matches an "Inspect: <url>" line whether it is appended to a reply (preceded by
// a newline) OR delivered as its own standalone message (no leading newline).
const INSPECT_FOOTER_RE = /(^|\n)[ \t]*Inspect:\s*https?:\/\/\S+\s*$/i;

export function stripInspectFooter(text: string): string {
  return text.replace(INSPECT_FOOTER_RE, "").trimEnd();
}

// ---------------------------------------------------------------------------
// Text messages
// ---------------------------------------------------------------------------

export async function sendText(
  config: WhatsAppCloudConfig,
  to: string,
  text: string,
  log: Logger,
  opts?: SendOptions
): Promise<SendResult> {
  // Strip the operator-only run-inspection footer before anything else. If the
  // message was ONLY that footer (delivered as its own message), drop it entirely.
  const beforeStrip = text;
  text = stripInspectFooter(text);
  if (!text.trim()) {
    if (beforeStrip.trim() && beforeStrip.trim() !== text.trim()) {
      log.info?.("[whatsapp-cloud] Dropped standalone Inspect-footer message");
      return { ok: true, messageId: "suppressed-inspect-footer" };
    }
  }

  // Never relay OpenClaw's own service/fallback notices to the user unless the
  // operator explicitly opted in (suppressServiceNotices === false). Returning
  // ok makes the core dispatcher treat it as delivered, so it does not retry or
  // escalate. When a replacement is configured, send that friendlier text instead.
  if (config.suppressServiceNotices !== false && isServiceNotice(text)) {
    const replacement = config.serviceNoticeReplacement?.trim();
    if (!replacement) {
      log.info?.("[whatsapp-cloud] Suppressed OpenClaw service notice (not relayed to user)");
      return { ok: true, messageId: "suppressed-service-notice" };
    }
    log.info?.("[whatsapp-cloud] Replaced OpenClaw service notice with configured text");
    text = replacement;
  }

  // WhatsApp has a 4096 character limit per text message
  // Split long messages into chunks
  const chunks = splitMessage(text, 4096);
  let lastResult: SendResult = { ok: false, error: "No chunks" };

  for (const [i, chunk] of chunks.entries()) {
    const body: SendTextRequest = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: chunk },
    };
    // Only the first chunk quotes the original message.
    const withReply = i === 0 ? withContext(body, opts) : body;
    lastResult = await sendRequest(config, withReply as unknown as Record<string, unknown>, log);
    if (!lastResult.ok) return lastResult;
  }

  return lastResult;
}

// ---------------------------------------------------------------------------
// Template messages (required outside the 24-hour window)
// ---------------------------------------------------------------------------

export async function sendTemplate(
  config: WhatsAppCloudConfig,
  to: string,
  templateName: string,
  languageCode: string = "en",
  components?: TemplateComponent[],
  log?: Logger
): Promise<SendResult> {
  const body: SendTemplateRequest = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components ? { components } : {}),
    },
  };
  return sendRequest(
    config,
    body as unknown as Record<string, unknown>,
    log ?? console as unknown as Logger
  );
}

// ---------------------------------------------------------------------------
// Interactive messages (buttons and lists)
// ---------------------------------------------------------------------------

export async function sendInteractive(
  config: WhatsAppCloudConfig,
  to: string,
  interactive: InteractiveMessage,
  log: Logger,
  opts?: SendOptions
): Promise<SendResult> {
  const body: SendInteractiveRequest = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive,
  };
  return sendRequest(config, withContext(body, opts) as unknown as Record<string, unknown>, log);
}

/**
 * Send a message with up to 3 quick reply buttons.
 * Convenience wrapper around sendInteractive.
 */
export async function sendButtons(
  config: WhatsAppCloudConfig,
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  log: Logger
): Promise<SendResult> {
  return sendInteractive(
    config,
    to,
    {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply" as const,
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
    log
  );
}

// ---------------------------------------------------------------------------
// Media messages
// ---------------------------------------------------------------------------

export async function sendMedia(
  config: WhatsAppCloudConfig,
  to: string,
  mediaType: "image" | "audio" | "video" | "document",
  media: { link?: string; id?: string; caption?: string; filename?: string; voice?: boolean },
  log: Logger,
  opts?: SendOptions
): Promise<SendResult> {
  const body: SendMediaRequest = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: mediaType,
    [mediaType]: media,
  };
  return sendRequest(config, withContext(body, opts) as unknown as Record<string, unknown>, log);
}

/**
 * Upload media bytes to Meta's Media endpoint and return the media ID.
 * Messages can only reference media by public URL (`link`) or by this ID, so a
 * local file must be uploaded first.
 */
export async function uploadMedia(
  config: WhatsAppCloudConfig,
  data: Buffer,
  mimeType: string,
  filename: string,
  log: Logger
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const url = apiUrl(config, `${config.phoneNumberId}/media`);
  const makeForm = () => {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    return form;
  };

  try {
    // No Content-Type header: fetch sets the multipart boundary itself.
    const { response, err } = await fetchWithRetry(
      url,
      () => ({
        method: "POST",
        headers: { Authorization: `Bearer ${config.accessToken}` },
        body: makeForm(),
      }),
      log
    );

    if (!response.ok) {
      const errorMsg =
        err?.error?.message ?? `HTTP ${response.status} ${response.statusText}`;
      log.error(`[whatsapp-cloud] Media upload error: ${errorMsg}`);
      return { ok: false, error: errorMsg };
    }

    const json = (await response.json()) as { id?: string };
    if (!json.id) return { ok: false, error: "Media upload returned no id" };
    return { ok: true, id: json.id };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`[whatsapp-cloud] Media upload network error: ${errorMsg}`);
    return { ok: false, error: errorMsg };
  }
}

// ---------------------------------------------------------------------------
// Read receipts
// ---------------------------------------------------------------------------

export async function markAsRead(
  config: WhatsAppCloudConfig,
  messageId: string,
  log: Logger
): Promise<void> {
  const url = apiUrl(config, `${config.phoneNumberId}/messages`);

  try {
    await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  } catch (err) {
    log.debug(`[whatsapp-cloud] Failed to send read receipt: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Typing indicators
// ---------------------------------------------------------------------------

/**
 * Show a "typing..." indicator to the user.
 * The indicator is automatically removed when you send a reply or after 25s.
 * Requires the message_id of the received message to attach to.
 */
export async function sendTypingIndicator(
  config: WhatsAppCloudConfig,
  messageId: string,
  log: Logger
): Promise<void> {
  const url = apiUrl(config, `${config.phoneNumberId}/messages`);

  try {
    await fetch(url, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: {
          type: "text",
        },
      }),
    });
  } catch (err) {
    log.debug?.(`[whatsapp-cloud] Failed to send typing indicator: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Media download (for receiving media from users)
// ---------------------------------------------------------------------------

/**
 * Get the download URL for a media object.
 * The URL is temporary and requires the access token to download.
 */
export async function getMediaUrl(
  config: WhatsAppCloudConfig,
  mediaId: string,
  log: Logger
): Promise<string | null> {
  const url = apiUrl(config, mediaId);

  try {
    const response = await fetch(url, { headers: headers(config) });
    if (!response.ok) {
      log.error(`[whatsapp-cloud] Failed to get media URL: ${response.status}`);
      return null;
    }
    const data = (await response.json()) as MediaUrlResponse;
    return data.url;
  } catch (err) {
    log.error(`[whatsapp-cloud] Failed to get media URL: ${err}`);
    return null;
  }
}

/**
 * Download media binary content from Meta's CDN.
 */
export async function downloadMedia(
  config: WhatsAppCloudConfig,
  mediaUrl: string,
  log: Logger
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const response = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    if (!response.ok) {
      log.error(`[whatsapp-cloud] Media download failed: ${response.status}`);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
    return { buffer, mimeType };
  } catch (err) {
    log.error(`[whatsapp-cloud] Media download error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a long message into chunks, respecting word boundaries */
function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Find last newline or space before the limit
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex < maxLength * 0.3) {
      splitIndex = maxLength; // hard split
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}
