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
import { getMediaUrl, downloadMedia } from "./api.js";
import type { WhatsAppCloudConfig, Logger } from "./types.js";

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
