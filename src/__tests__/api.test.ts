import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WhatsAppCloudConfig } from "../types.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Import after mocking
import { sendText, sendButtons, sendMedia, markAsRead, getMediaUrl, isServiceNotice, stripInspectFooter } from "../api.js";

const mockLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

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

function mockApiSuccess(messageId: string = "wamid.sent123") {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      messaging_product: "whatsapp",
      contacts: [{ input: "+393491234567", wa_id: "393491234567" }],
      messages: [{ id: messageId }],
    }),
  });
}

function mockApiError(code: number = 400, message: string = "Bad request") {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: code,
    statusText: "Bad Request",
    json: async () => ({
      error: {
        message,
        type: "OAuthException",
        code,
        fbtrace_id: "trace123",
      },
    }),
  });
}

describe("sendText", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a text message successfully", async () => {
    const config = makeConfig();
    mockApiSuccess();

    const result = await sendText(config, "393491234567", "Ciao!", mockLog);

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("wamid.sent123");

    // Verify the correct API call
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe("https://graph.facebook.com/v21.0/111222333/messages");
    expect(options.method).toBe("POST");

    const body = JSON.parse(options.body);
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.to).toBe("393491234567");
    expect(body.type).toBe("text");
    expect(body.text.body).toBe("Ciao!");
  });

  it("handles API errors gracefully", async () => {
    const config = makeConfig();
    mockApiError(401, "Invalid OAuth token");

    const result = await sendText(config, "393491234567", "Hello", mockLog);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid OAuth token");
  });

  it("handles network errors", async () => {
    const config = makeConfig();
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await sendText(config, "393491234567", "Hello", mockLog);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("splits long messages into chunks", async () => {
    const config = makeConfig();
    const longText = "A".repeat(5000); // Over 4096 limit

    // Need two success responses for two chunks
    mockApiSuccess("wamid.chunk1");
    mockApiSuccess("wamid.chunk2");

    const result = await sendText(config, "393491234567", longText, mockLog);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

const FALLBACK_NOTICE =
  "⚠️ OpenClaw couldn't produce or deliver a reply. Please try again. If this keeps happening, ask the operator to check the gateway logs.";

describe("isServiceNotice", () => {
  it("matches the no-visible-reply fallback (with and without a run reference)", () => {
    expect(isServiceNotice(FALLBACK_NOTICE)).toBe(true);
    expect(isServiceNotice(`${FALLBACK_NOTICE} Reference: abc123.`)).toBe(true);
  });

  it("matches the queue-cap rejection notice", () => {
    expect(
      isServiceNotice("This message was not queued because the session queue is full. Please try again later.")
    ).toBe(true);
  });

  it("does not match a normal agent reply", () => {
    expect(isServiceNotice("Ciao! Come posso aiutarti?")).toBe(false);
    expect(isServiceNotice("⚠️ Attenzione: la ricetta richiede 20 minuti.")).toBe(false);
  });
});

describe("stripInspectFooter", () => {
  it("removes a trailing Inspect run link", () => {
    const t = "Buongiorno Annalisa, buona giornata!\nInspect: https://x.ngrok-free.dev/chat/public/cron/abc/run/def";
    expect(stripInspectFooter(t)).toBe("Buongiorno Annalisa, buona giornata!");
  });
  it("leaves a normal message untouched", () => {
    expect(stripInspectFooter("Ciao, come va?")).toBe("Ciao, come va?");
  });
  it("does not strip the word Inspect mid-text", () => {
    const t = "Inspect the pipes, then call me.";
    expect(stripInspectFooter(t)).toBe(t);
  });
});

describe("sendText strips inspect footer before sending", () => {
  beforeEach(() => vi.clearAllMocks());
  it("sends only the message body, not the Inspect footer", async () => {
    const config = makeConfig();
    mockApiSuccess();
    await sendText(config, "393491234567", "Buongiorno!\nInspect: https://x.ngrok-free.dev/chat/public/cron/a/run/b", mockLog);
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text.body).toBe("Buongiorno!");
    expect(body.text.body).not.toContain("Inspect");
  });
});

describe("sendText service-notice suppression", () => {
  beforeEach(() => vi.clearAllMocks());

  it("drops a service notice without calling the API (default)", async () => {
    const config = makeConfig(); // suppressServiceNotices: true

    const result = await sendText(config, "393491234567", FALLBACK_NOTICE, mockLog);

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("suppressed-service-notice");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("relays the notice when suppression is disabled", async () => {
    const config = { ...makeConfig(), suppressServiceNotices: false };
    mockApiSuccess();

    const result = await sendText(config, "393491234567", FALLBACK_NOTICE, mockLog);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text.body).toBe(FALLBACK_NOTICE);
  });

  it("sends the configured replacement text instead of the notice", async () => {
    const config = {
      ...makeConfig(),
      serviceNoticeReplacement: "Un momento, riprova tra poco 🙏",
    };
    mockApiSuccess();

    const result = await sendText(config, "393491234567", FALLBACK_NOTICE, mockLog);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.text.body).toBe("Un momento, riprova tra poco 🙏");
  });

  it("never suppresses a normal agent reply", async () => {
    const config = makeConfig();
    mockApiSuccess();

    const result = await sendText(config, "393491234567", "Ecco la risposta.", mockLog);

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

describe("sendButtons", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends interactive buttons", async () => {
    const config = makeConfig();
    mockApiSuccess();

    const result = await sendButtons(
      config,
      "393491234567",
      "Choose an option:",
      [
        { id: "opt_a", title: "Option A" },
        { id: "opt_b", title: "Option B" },
      ],
      mockLog
    );

    expect(result.ok).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("button");
    expect(body.interactive.body.text).toBe("Choose an option:");
    expect(body.interactive.action.buttons).toHaveLength(2);
    expect(body.interactive.action.buttons[0].reply.id).toBe("opt_a");
  });

  it("limits to 3 buttons max", async () => {
    const config = makeConfig();
    mockApiSuccess();

    await sendButtons(
      config,
      "393491234567",
      "Pick:",
      [
        { id: "1", title: "One" },
        { id: "2", title: "Two" },
        { id: "3", title: "Three" },
        { id: "4", title: "Four" }, // should be dropped
      ],
      mockLog
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.interactive.action.buttons).toHaveLength(3);
  });

  it("truncates button titles to 20 chars", async () => {
    const config = makeConfig();
    mockApiSuccess();

    await sendButtons(
      config,
      "393491234567",
      "Pick:",
      [{ id: "1", title: "This is a very long button title that exceeds the limit" }],
      mockLog
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.interactive.action.buttons[0].reply.title.length).toBeLessThanOrEqual(20);
  });
});

describe("sendMedia", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends an image by URL", async () => {
    const config = makeConfig();
    mockApiSuccess();

    const result = await sendMedia(
      config,
      "393491234567",
      "image",
      { link: "https://example.com/photo.jpg", caption: "My photo" },
      mockLog
    );

    expect(result.ok).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe("image");
    expect(body.image.link).toBe("https://example.com/photo.jpg");
    expect(body.image.caption).toBe("My photo");
  });

  it("sends a document by media ID", async () => {
    const config = makeConfig();
    mockApiSuccess();

    await sendMedia(
      config,
      "393491234567",
      "document",
      { id: "media_123", filename: "report.pdf" },
      mockLog
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe("document");
    expect(body.document.id).toBe("media_123");
    expect(body.document.filename).toBe("report.pdf");
  });
});

describe("markAsRead", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a read receipt", async () => {
    const config = makeConfig();
    mockFetch.mockResolvedValueOnce({ ok: true });

    await markAsRead(config, "wamid.msg123", mockLog);

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.status).toBe("read");
    expect(body.message_id).toBe("wamid.msg123");
  });

  it("does not throw on failure", async () => {
    const config = makeConfig();
    mockFetch.mockRejectedValueOnce(new Error("timeout"));

    // Should not throw
    await markAsRead(config, "wamid.msg123", mockLog);
  });
});

describe("getMediaUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("retrieves a media download URL", async () => {
    const config = makeConfig();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: "https://lookaside.fbsbx.com/media/123",
        mime_type: "image/jpeg",
        sha256: "abc",
        file_size: 12345,
        id: "media_123",
        messaging_product: "whatsapp",
      }),
    });

    const url = await getMediaUrl(config, "media_123", mockLog);
    expect(url).toBe("https://lookaside.fbsbx.com/media/123");
  });

  it("returns null on failure", async () => {
    const config = makeConfig();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const url = await getMediaUrl(config, "bad_id", mockLog);
    expect(url).toBeNull();
  });
});
