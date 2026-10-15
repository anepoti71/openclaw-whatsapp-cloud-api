import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WhatsAppCloudConfig } from "../types.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { renderPresentationForWhatsApp, inboundTextForChoice } from "../presentation.js";
import { deliverPayload, startTypingKeepalive } from "../index.js";

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

function okSend(id = "wamid.x") {
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id }] }) });
}

function body(i: number) {
  return JSON.parse(mockFetch.mock.calls[i][1].body);
}

describe("renderPresentationForWhatsApp", () => {
  it("renders up to 3 choices as reply buttons with a header", () => {
    const r = renderPresentationForWhatsApp({
      title: "Conferma",
      blocks: [
        { type: "text", text: "Confermi l'appuntamento?" },
        {
          type: "buttons",
          buttons: [
            { label: "Sì", action: { type: "callback", value: "yes" } },
            { label: "No", action: { type: "command", command: "/cancel" } },
          ],
        },
      ],
    });

    expect(r.text).toBeUndefined();
    expect(r.interactive).toEqual({
      type: "button",
      header: { type: "text", text: "Conferma" },
      body: { text: "Confermi l'appuntamento?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "cb:yes", title: "Sì" } },
          { type: "reply", reply: { id: "cmd:/cancel", title: "No" } },
        ],
      },
    });
  });

  it("uses a list for more than 3 choices or a select", () => {
    const r = renderPresentationForWhatsApp({
      blocks: [
        { type: "text", text: "Scegli l'orario" },
        {
          type: "select",
          placeholder: "Orari",
          options: ["9:00", "10:00", "11:00", "12:00"].map((t) => ({ label: t, value: t })),
        },
      ],
    });

    expect(r.interactive?.type).toBe("list");
    expect(r.interactive?.action.button).toBe("Orari");
    expect(r.interactive?.action.sections?.[0].rows.map((row) => row.id)).toEqual([
      "cb:9:00",
      "cb:10:00",
      "cb:11:00",
      "cb:12:00",
    ]);
  });

  it("turns link buttons into text lines and returns plain text when no choices remain", () => {
    const r = renderPresentationForWhatsApp({
      title: "Note",
      blocks: [
        { type: "text", text: "Pronte." },
        { type: "buttons", buttons: [{ label: "Apri", action: { type: "url", url: "https://x.test/n" } }] },
      ],
    });

    expect(r.interactive).toBeUndefined();
    expect(r.text).toBe("*Note*\nPronte.\nApri: https://x.test/n");
  });

  it("flattens tables into text lines", () => {
    const r = renderPresentationForWhatsApp({
      blocks: [{ type: "table", caption: "Pipeline", headers: ["A", "B"], rows: [["x", 1]] }],
    });
    expect(r.text).toBe("*Pipeline*\n- A: x; B: 1");
  });

  it("truncates button titles and dedupes ids", () => {
    const r = renderPresentationForWhatsApp({
      blocks: [
        { type: "text", text: "t" },
        { type: "buttons", buttons: [{ label: "A very long button label here" }, { label: "A very long button label here" }] },
      ],
    });
    const buttons = r.interactive?.action.buttons ?? [];
    expect(buttons[0].reply.title).toHaveLength(20);
    expect(buttons[0].reply.id).not.toBe(buttons[1].reply.id);
  });

  it("splits an over-long body into a separate text message", () => {
    const long = "x".repeat(1500);
    const r = renderPresentationForWhatsApp({
      blocks: [{ type: "text", text: long }, { type: "buttons", buttons: [{ label: "Ok" }] }],
    });
    expect(r.text).toBe(long);
    expect(r.interactive?.body.text).toBe("👇");
  });
});

describe("inboundTextForChoice", () => {
  it("maps command ids to the command and others to the label", () => {
    expect(inboundTextForChoice("cmd:/cancel", "No")).toBe("/cancel");
    expect(inboundTextForChoice("cmd:/cancel#1", "No")).toBe("/cancel");
    expect(inboundTextForChoice("cb:yes", "Sì")).toBe("Sì");
  });
});

describe("deliverPayload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends text then interactive, quoting only the first message", async () => {
    okSend();
    okSend();

    const results = await deliverPayload(
      makeConfig(),
      "393491234567",
      {
        text: "Ecco le opzioni",
        replyToId: "wamid.orig",
        presentation: { blocks: [{ type: "text", text: "Scegli" }, { type: "buttons", buttons: [{ label: "A" }] }] },
      },
      mockLog
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(body(0).type).toBe("text");
    expect(body(0).context).toEqual({ message_id: "wamid.orig" });
    expect(body(1).type).toBe("interactive");
    expect(body(1).context).toBeUndefined();
  });

  it("drops authored fallback text when buttons render natively", async () => {
    okSend();

    await deliverPayload(
      makeConfig(),
      "393491234567",
      {
        text: "A or B?",
        presentationTextMode: "fallback",
        presentation: { blocks: [{ type: "text", text: "Pick" }, { type: "buttons", buttons: [{ label: "A" }, { label: "B" }] }] },
      },
      mockLog
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(body(0).type).toBe("interactive");
  });

  it("reads the presentation from channelData when core rendered it", async () => {
    okSend();

    await deliverPayload(
      makeConfig(),
      "393491234567",
      { channelData: { "whatsapp-cloud": { presentation: { blocks: [{ type: "text", text: "t" }, { type: "buttons", buttons: [{ label: "Ok" }] }] } } } },
      mockLog
    );

    expect(body(0).type).toBe("interactive");
  });
});

describe("startTypingKeepalive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => {
    vi.useRealTimers();
    mockFetch.mockReset();
  });

  it("renews every 20s until stopped", async () => {
    const stop = startTypingKeepalive(makeConfig(), "wamid.in", mockLog);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(41_000);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("stops on its own after 10 minutes", async () => {
    startTypingKeepalive(makeConfig(), "wamid.in", mockLog);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const calls = mockFetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mockFetch.mock.calls.length).toBe(calls);
  });
});
