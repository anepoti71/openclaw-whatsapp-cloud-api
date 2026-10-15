import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { saveInboundMedia, mediaKindFromMime, resolveInboundMediaDir, sendOutboundMedia, mimeFromPath } from "../media.js";
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

describe("sendOutboundMedia", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-out-"));
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  function sentBody(callIndex: number) {
    return JSON.parse(mockFetch.mock.calls[callIndex][1].body);
  }

  it("sends a remote https URL as link without uploading", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id: "wamid.1" }] }) });

    const result = await sendOutboundMedia(makeConfig(), "393491234567", "https://example.com/a.png", "hi", mockLog);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentBody(0).image).toEqual({ link: "https://example.com/a.png", caption: "hi" });
  });

  it("uploads a local image and sends it by media id", async () => {
    const file = path.join(tmpDir, "immagine.png");
    fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "media-42" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id: "wamid.2" }] }) });

    const result = await sendOutboundMedia(makeConfig(), "393491234567", file, "eccola", mockLog);

    expect(result).toEqual({ ok: true, messageId: "wamid.2" });
    const [uploadUrl, uploadInit] = mockFetch.mock.calls[0];
    expect(uploadUrl).toBe("https://graph.facebook.com/v21.0/111222333/media");
    const form = uploadInit.body as FormData;
    expect(form.get("messaging_product")).toBe("whatsapp");
    expect(form.get("type")).toBe("image/png");
    expect((form.get("file") as File).name).toBe("immagine.png");
    expect(sentBody(1).type).toBe("image");
    expect(sentBody(1).image).toEqual({ id: "media-42", caption: "eccola" });
  });

  it("accepts file:// URLs", async () => {
    const file = path.join(tmpDir, "x.jpg");
    fs.writeFileSync(file, "jpg");
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "media-1" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id: "wamid.3" }] }) });

    const result = await sendOutboundMedia(makeConfig(), "393491234567", `file://${file}`, undefined, mockLog);

    expect(result.ok).toBe(true);
    expect(sentBody(1).image).toEqual({ id: "media-1" });
  });

  it("sends non-media files as a document with filename", async () => {
    const file = path.join(tmpDir, "report.pdf");
    fs.writeFileSync(file, "%PDF");
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: "media-9" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id: "wamid.4" }] }) });

    await sendOutboundMedia(makeConfig(), "393491234567", file, "doc", mockLog);

    expect(sentBody(1).type).toBe("document");
    expect(sentBody(1).document).toEqual({ id: "media-9", caption: "doc", filename: "report.pdf" });
  });

  it("fails without calling Meta when the local file is missing", async () => {
    const result = await sendOutboundMedia(makeConfig(), "393491234567", path.join(tmpDir, "nope.png"), undefined, mockLog);

    expect(result.ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns the upload error and does not send a message", async () => {
    const file = path.join(tmpDir, "a.png");
    fs.writeFileSync(file, "png");
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: async () => ({ error: { message: "bad file" } }),
    });

    const result = await sendOutboundMedia(makeConfig(), "393491234567", file, undefined, mockLog);

    expect(result).toEqual({ ok: false, error: "Media upload failed: bad file" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("mimeFromPath", () => {
  it("maps known extensions and ignores query strings", () => {
    expect(mimeFromPath("/a/b.PNG")).toBe("image/png");
    expect(mimeFromPath("https://x/y.jpg?sig=1")).toBe("image/jpeg");
    expect(mimeFromPath("/a/b.xyz")).toBe("application/octet-stream");
  });
});
