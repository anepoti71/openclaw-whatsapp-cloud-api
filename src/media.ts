// ---------------------------------------------------------------------------
// Inbound media handling
// ---------------------------------------------------------------------------
// WhatsApp media (voice notes, images, video, documents) can only be fetched
// from graph.facebook.com with the access token, so OpenClaw cannot download it
// on its own. This module downloads the bytes and saves them to a local file,
// returning a MediaFact-shaped record the channel attaches to MsgContext.media.
// OpenClaw's media-understanding pipeline then transcribes audio and reads
// images/video during the agent turn. Without this, a voice note reaches the
// agent as a bare "[🎵 Audio message]" placeholder (the pre-Cloud/Baileys
// channel transcribed voice notes; this restores that).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getMediaUrl, downloadMedia, sendMedia, uploadMedia } from "./api.js";
import type { WhatsAppCloudConfig, Logger, SendResult } from "./types.js";

export type MediaKind = "image" | "audio" | "video" | "document";

/** Subset of OpenClaw's MediaFact that this channel populates for inbound media. */
export interface InboundMediaFact {
  path: string;
  contentType: string;
  kind: MediaKind;
  fileName?: string;
  sizeBytes?: number;
}

/** Map a MIME type to OpenClaw's MediaKind. */
export function mediaKindFromMime(mime: string | undefined): MediaKind {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "document";
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/amr": "amr",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "application/pdf": "pdf",
};

function extFromMime(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (EXT_BY_MIME[base]) return EXT_BY_MIME[base];
  const sub = base.split("/")[1];
  return (sub ? sub.replace(/[^a-z0-9]/g, "") : "") || "bin";
}

/** Directory where inbound media is cached (OPENCLAW_STATE_DIR aware). */
export function resolveInboundMediaDir(): string {
  const base =
    (process.env.OPENCLAW_STATE_DIR && process.env.OPENCLAW_STATE_DIR.trim()) ||
    path.join(os.homedir(), ".openclaw");
  return path.join(base, "media", "whatsapp-cloud");
}

/**
 * Download an inbound WhatsApp media item and save it to a local file.
 * Returns a MediaFact to attach to MsgContext.media, or null on failure.
 */
export async function saveInboundMedia(
  config: WhatsAppCloudConfig,
  media: { id: string; mimeType?: string; filename?: string },
  messageId: string,
  log: Logger
): Promise<InboundMediaFact | null> {
  const url = await getMediaUrl(config, media.id, log);
  if (!url) return null;

  const dl = await downloadMedia(config, url, log);
  if (!dl) return null;

  const contentType = media.mimeType || dl.mimeType || "application/octet-stream";
  const kind = mediaKindFromMime(contentType);

  try {
    const dir = resolveInboundMediaDir();
    fs.mkdirSync(dir, { recursive: true });
    const safeId = String(messageId || media.id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
    const ext = extFromMime(contentType);
    const filePath = path.join(dir, `${safeId}.${ext}`);
    fs.writeFileSync(filePath, dl.buffer);
    return {
      path: filePath,
      contentType,
      kind,
      fileName: media.filename || `${safeId}.${ext}`,
      sizeBytes: dl.buffer.length,
    };
  } catch (err) {
    log.error(`[whatsapp-cloud] Failed to save inbound media: ${String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Outbound media handling
// ---------------------------------------------------------------------------
// Agents hand the channel either a public URL or a local file path (e.g. a
// generated image). Meta only accepts `link` for a reachable http(s) URL, so a
// local path must be uploaded to the Media endpoint and sent by `id`; putting a
// path in `link` fails with "(#100) Param image.link is not a valid URI".
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  mp4: "video/mp4",
  "3gp": "video/3gpp",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
  pdf: "application/pdf",
};

/** Guess MIME type from a path or URL extension (octet-stream when unknown). */
export function mimeFromPath(ref: string): string {
  const clean = ref.split(/[?#]/)[0] ?? "";
  const ext = path.extname(clean).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Resolve an outbound media reference to a local file path, or null when it is
 * a remote http(s) URL that Meta can fetch itself.
 */
export function resolveLocalMediaPath(ref: string): string | null {
  if (/^https?:\/\//i.test(ref)) return null;
  if (/^file:\/\//i.test(ref)) return fileURLToPath(ref);
  return path.resolve(ref);
}

/**
 * Send a media reference (URL or local path) to a WhatsApp recipient. Local
 * files are uploaded first and sent by media ID. Images/video/audio go out as
 * their own type; anything else is sent as a document.
 */
export async function sendOutboundMedia(
  config: WhatsAppCloudConfig,
  to: string,
  ref: string,
  caption: string | undefined,
  log: Logger
): Promise<SendResult> {
  const mimeType = mimeFromPath(ref);
  const kind = mediaKindFromMime(mimeType);
  const localPath = resolveLocalMediaPath(ref);
  const filename = path.basename((localPath ?? ref).split(/[?#]/)[0] ?? "") || "file";

  let media: { link?: string; id?: string };
  if (localPath === null) {
    media = { link: ref };
  } else {
    let data: Buffer;
    try {
      data = fs.readFileSync(localPath);
    } catch (err) {
      const error = `Cannot read local media ${localPath}: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`[whatsapp-cloud] ${error}`);
      return { ok: false, error };
    }
    const upload = await uploadMedia(config, data, mimeType, filename, log);
    if (!upload.ok) return { ok: false, error: `Media upload failed: ${upload.error}` };
    media = { id: upload.id };
  }

  return sendMedia(
    config,
    to,
    kind,
    {
      ...media,
      // Audio messages do not accept a caption.
      ...(caption && kind !== "audio" ? { caption } : {}),
      ...(kind === "document" ? { filename } : {}),
    },
    log
  );
}
