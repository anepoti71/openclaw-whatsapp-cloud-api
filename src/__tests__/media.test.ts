import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { saveInboundMedia, mediaKindFromMime, resolveInboundMediaDir } from "../media.js";
import type { WhatsAppCloudConfig } from "../types.js";

const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function makeConfig(): WhatsAppCloudConfig {
  return {
    enabled: true,
    phoneNumberId: "111222333",
    businessAccountId: "444555666",
    accessToken: "test_token",
    appSecret: "test_secret",
    verifyToken: "test-verify",
    webhookPort: 3100,
    webhookPath: "/webhook/whatsapp-cloud",
    apiVersion: "v21.0",
    dmPolicy: "open",
    allowFrom: [],
    sendReadReceipts: true,
    downloadInboundMedia: true,
    suppressServiceNotices: true,
  };
}

let tmpState: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "wa-media-"));
  process.env.OPENCLAW_STATE_DIR = tmpState;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(tmpState, { recursive: true, force: true });
});

describe("mediaKindFromMime", () => {
  it("maps common MIME types", () => {
    expect(mediaKindFromMime("audio/ogg")).toBe("audio");
    expect(mediaKindFromMime("image/jpeg")).toBe("image");
    expect(mediaKindFromMime("video/mp4")).toBe("video");
    expect(mediaKindFromMime("application/pdf")).toBe("document");
    expect(mediaKindFromMime(undefined)).toBe("document");
  });
});

describe("saveInboundMedia", () => {
  it("downloads a voice note and returns an audio MediaFact", async () => {
    // 1) getMediaUrl
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ url: "https://cdn.example/aud", mime_type: "audio/ogg" }),
    });
    // 2) downloadMedia
    const bytes = Buffer.from("fake-ogg-bytes");
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => bytes,
      headers: { get: () => "audio/ogg" },
    });

    const fact = await saveInboundMedia(
      makeConfig(),
      { id: "MEDIA1", mimeType: "audio/ogg" },
      "wamid.ABC",
      mockLog
    );

    expect(fact).not.toBeNull();
    expect(fact!.kind).toBe("audio");
    expect(fact!.contentType).toBe("audio/ogg");
    expect(fact!.path.startsWith(resolveInboundMediaDir())).toBe(true);
    expect(fact!.path.endsWith(".ogg")).toBe(true);
    expect(fs.existsSync(fact!.path)).toBe(true);
    expect(fs.readFileSync(fact!.path)).toEqual(bytes);
    expect(fact!.sizeBytes).toBe(bytes.length);
  });

  it("returns null when the media URL cannot be resolved", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) });
    const fact = await saveInboundMedia(makeConfig(), { id: "X" }, "m", mockLog);
    expect(fact).toBeNull();
  });

  it("returns null when the download fails", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://cdn/x" }) });
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const fact = await saveInboundMedia(makeConfig(), { id: "X", mimeType: "image/png" }, "m", mockLog);
    expect(fact).toBeNull();
  });

  it("uses an image extension for image media", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ url: "https://cdn/i" }) });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => Buffer.from("img"),
      headers: { get: () => "image/jpeg" },
    });
    const fact = await saveInboundMedia(makeConfig(), { id: "I", mimeType: "image/jpeg" }, "mid", mockLog);
    expect(fact!.kind).toBe("image");
    expect(fact!.path.endsWith(".jpg")).toBe(true);
  });
});
