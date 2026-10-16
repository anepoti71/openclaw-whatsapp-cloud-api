// ---------------------------------------------------------------------------
// OpenClaw Channel Plugin — WhatsApp Cloud API
//
// Uses Meta's official WhatsApp Cloud API (graph.facebook.com) instead of
// Baileys. Production-safe for business use: no ban risk, verified numbers,
// template messages, and full compliance with Meta's policies.
//
// Author: Baia Digitale SRL (baiadigitale.com)
// License: MIT
// ---------------------------------------------------------------------------

import type { Server } from "node:http";
import { sendText, sendInteractive, sendTypingIndicator } from "./api.js";
import { applyToneTag } from "./tone.js";
import { saveInboundMedia, sendOutboundMedia } from "./media.js";
import { renderPresentationForWhatsApp, inboundTextForChoice, PRESENTATION_CAPABILITIES } from "./presentation.js";
import { startWebhookServer, handleWebhookRequest } from "./webhook.js";
import type { ParsedInboundMessage } from "./webhook.js";
import { runSetupWizard, validateConfig } from "./setup.js";
import { whatsappCloudOnboardingAdapter } from "./onboarding.js";
import type { WhatsAppCloudConfig, Logger, SecretRef, SendResult } from "./types.js";
import { CONFIG_DEFAULTS } from "./types.js";
import { setWhatsAppCloudRuntime, getWhatsAppCloudRuntime } from "./runtime.js";
import { channelSecrets as whatsappCloudSecretContract } from "./secret-contract-api.js";

// ---------------------------------------------------------------------------
// Account resolution types
// ---------------------------------------------------------------------------

interface ResolvedWhatsAppCloudAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  config: WhatsAppCloudConfig;
  /** Where the token came from: "config" or "none" */
  tokenSource: string;
}

// Runtime state
let webhookServer: Server | null = null;
// True when the webhook is mounted on the gateway's shared HTTP server
// (via api.registerHttpRoute) instead of a standalone server on webhookPort.
let gatewayRouteMounted = false;

// Default account ID constant (matches OpenClaw convention)
const DEFAULT_ACCOUNT_ID = "default";

// ---------------------------------------------------------------------------
// Inbound dispatch — shared by the standalone server and the gateway route
// ---------------------------------------------------------------------------

/**
 * Resolve the agent id to route inbound messages to. Uses the single configured
 * agent when there is exactly one, otherwise falls back to "main" (OpenClaw's
 * default agent id). The canonical session key embeds this as its first segment.
 */
function resolveAgentId(cfg: any): string {
  const entries = cfg?.agents?.entries;
  if (entries && typeof entries === "object") {
    const ids = Object.keys(entries);
    if (ids.length === 1) return ids[0];
  }
  return "main";
}

/**
 * Pick the agent and session key for an inbound DM. Delegates to OpenClaw's
 * router so `bindings` (per-peer / per-channel) decide which agent answers and
 * the session key follows `session.dmScope`. Falls back to the canonical
 * per-channel-peer key on the single/"main" agent when the router is missing
 * or cannot select an agent.
 */
export function resolveInboundRoute(
  runtime: any,
  cfg: any,
  accountId: string,
  from: string,
  log?: Logger
): { agentId: string; sessionKey: string } {
  const peerId = from.startsWith("+") ? from : `+${from}`;
  const resolveAgentRoute = runtime?.channel?.routing?.resolveAgentRoute;
  if (typeof resolveAgentRoute === "function") {
    try {
      const route = resolveAgentRoute({
        cfg,
        channel: "whatsapp-cloud",
        accountId,
        peer: { kind: "direct", id: peerId },
        // Core defaults dmScope to "main" (all DMs share one session); keep
        // each sender isolated unless the config explicitly chooses otherwise.
        ...(cfg?.session?.dmScope ? {} : { dmScope: "per-channel-peer" }),
      });
      if (route?.agentId && route?.sessionKey) {
        return { agentId: route.agentId, sessionKey: route.sessionKey };
      }
    } catch (err) {
      log?.warn?.(`[whatsapp-cloud] Agent route resolution failed, using fallback: ${err}`);
    }
  }
  const agentId = resolveAgentId(cfg);
  return { agentId, sessionKey: `agent:${agentId}:whatsapp-cloud:direct:${peerId}` };
}

/**
 * Dispatch one parsed inbound WhatsApp message into an OpenClaw agent session.
 * Pulls a fresh config for each message so credential/policy edits apply
 * without a restart.
 */
async function dispatchInbound(
  message: ParsedInboundMessage,
  config: WhatsAppCloudConfig,
  runtime: any,
  accountId: string,
  log: Logger
): Promise<void> {
  let stopTyping = () => {};
  try {
    // Resolve any SecretRef-backed credentials before using them
    await ensureSecretsResolved(config, runtime);

    // Show typing indicator now and keep it alive for long turns (image
    // generation, tools): WhatsApp drops it after ~25s, and a silent chat makes
    // users resend, which starts duplicate work.
    stopTyping = startTypingKeepalive(config, message.messageId, log);

    // Load fresh config for dispatch
    const freshCfg = runtime.config.current();

    // Route via OpenClaw bindings; the key is agent:<agentId>:whatsapp-cloud:direct:<+e164peer>
    // under per-channel-peer, which keeps each sender in its own session.
    const { sessionKey } = resolveInboundRoute(runtime, freshCfg, accountId, message.from, log);

    // Build MsgContext (OpenClaw's standard inbound message format)
    const msgCtx: Record<string, any> = {
      Body: message.text,
      RawBody: message.text,
      CommandBody: message.text,
      BodyForCommands: message.text,
      From: message.from,
      To: config.phoneNumberId,
      SessionKey: sessionKey,
      AccountId: accountId,
      MessageSid: message.messageId,
      ChatType: "direct",
      SenderName: message.senderName,
      SenderId: message.from,
      Provider: "whatsapp-cloud",
      OriginatingChannel: "whatsapp-cloud",
      OriginatingTo: message.from,
      Timestamp: parseInt(message.timestamp, 10) * 1000,
    };

    // A tapped button/list row from a presentation: `cmd:` ids run the command.
    if (message.interactiveReply) {
      const text = inboundTextForChoice(message.interactiveReply.id, message.interactiveReply.title);
      msgCtx.Body = msgCtx.RawBody = msgCtx.CommandBody = msgCtx.BodyForCommands = text;
    }

    if (message.quotedMessageId) {
      msgCtx.ReplyToId = message.quotedMessageId;
    }

    // Download inbound media (voice notes, images, video, documents) and attach
    // it so OpenClaw's media-understanding transcribes audio / reads images
    // during the turn. WhatsApp media needs the access token to fetch, so the
    // channel must download it; OpenClaw cannot reach graph.facebook.com itself.
    if (config.downloadInboundMedia !== false && message.media?.id) {
      const fact = await saveInboundMedia(
        config,
        { id: message.media.id, mimeType: message.media.mimeType, filename: message.media.filename },
        message.messageId,
        log
      );
      if (fact) {
        msgCtx.media = [fact];
        // Drop the bare placeholder so the transcript/understanding drives the
        // turn; keep a real caption (image/video) as the body.
        if (fact.kind === "audio" && message.media.caption == null) {
          msgCtx.Body = message.media.caption ?? "";
          msgCtx.RawBody = msgCtx.Body;
          msgCtx.CommandBody = msgCtx.Body;
          msgCtx.BodyForCommands = msgCtx.Body;
        }
      } else {
        log.warn(`[whatsapp-cloud] Could not fetch inbound media ${message.media.id}; delivering placeholder text`);
      }
    }

    // Dispatch via OpenClaw's reply system
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: msgCtx,
      cfg: freshCfg,
      dispatcherOptions: {
        deliver: async (payload: any) => {
          // Capture a natural-language tone request: the agent emits an internal
          // <<TONE:...>> tag, which we persist (keyed by the user's number) and
          // strip before sending so the user never sees it.
          const text = payload.text ? applyToneTag(message.from, payload.text, log) : payload.text;
          const results = await deliverPayload(config, message.from, { ...payload, text }, log);
          for (const result of results) {
            if (!result.ok) log.warn?.(`[whatsapp-cloud] Reply to ${message.from} not delivered: ${result.error}`);
          }
        },
        onReplyStart: () => {
          log.info?.(`[whatsapp-cloud] Generating reply for ${message.senderName} (${message.from})`);
        },
      },
    });
  } catch (err) {
    log.error(`[whatsapp-cloud] Failed to dispatch inbound message: ${err}`);
  } finally {
    stopTyping();
  }
}

// ---------------------------------------------------------------------------
// Typing keepalive
// ---------------------------------------------------------------------------

const TYPING_RENEW_MS = 20_000;
const TYPING_MAX_MS = 10 * 60_000;

/** Send the typing indicator now and renew it until stopped (capped at 10 min). */
export function startTypingKeepalive(
  config: WhatsAppCloudConfig,
  messageId: string,
  log: Logger
): () => void {
  const send = () => sendTypingIndicator(config, messageId, log).catch(() => {});
  send();
  const timer = setInterval(send, TYPING_RENEW_MS);
  const cap = setTimeout(() => clearInterval(timer), TYPING_MAX_MS);
  timer.unref?.();
  cap.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(cap);
  };
}

// ---------------------------------------------------------------------------
// Payload delivery (shared by inbound replies and the outbound adapter)
// ---------------------------------------------------------------------------

export interface DeliverContext {
  /** Host-authorized local media reader from OpenClaw's outbound context. */
  readFile?: (filePath: string) => Promise<Buffer>;
  /** Host-authorized local media roots from OpenClaw's outbound context. */
  localRoots?: readonly string[];
}

/**
 * Send one OpenClaw reply payload: text, presentation (buttons/list), media.
 * Honors replyToId (quotes on the first message only) and audioAsVoice.
 * Returns one result per WhatsApp message attempted.
 */
export async function deliverPayload(
  config: WhatsAppCloudConfig,
  to: string,
  payload: any,
  log: Logger,
  ctx: DeliverContext = {}
): Promise<SendResult[]> {
  const results: SendResult[] = [];
  let quoted = false;
  const replyToId = (): string | undefined => {
    if (quoted || !payload.replyToId) return undefined;
    quoted = true;
    return payload.replyToId;
  };

  const presentation = payload.presentation ?? payload.channelData?.["whatsapp-cloud"]?.presentation;
  const rendered = presentation?.blocks?.length ? renderPresentationForWhatsApp(presentation) : undefined;
  const native = !!rendered?.interactive;
  const authoredFallback = payload.presentationTextMode === "fallback";

  // Authored fallback text is redundant when buttons render natively; when they
  // don't, it replaces the generic flattened presentation text.
  if (payload.text && !(native && authoredFallback)) {
    results.push(await sendText(config, to, payload.text, log, { replyToId: replyToId() }));
  }
  if (rendered?.text && !(!native && authoredFallback && payload.text)) {
    results.push(await sendText(config, to, rendered.text, log, { replyToId: replyToId() }));
  }
  if (rendered?.interactive) {
    results.push(await sendInteractive(config, to, rendered.interactive, log, { replyToId: replyToId() }));
  }

  // Unique: a payload may carry the same file in both mediaUrl and mediaUrls.
  const mediaRefs = [...new Set<string>([
    ...(payload.mediaUrl ? [payload.mediaUrl] : []),
    ...(payload.mediaUrls ?? []),
  ])];
  for (const ref of mediaRefs) {
    results.push(
      await sendOutboundMedia(config, to, ref, undefined, log, {
        replyToId: replyToId(),
        asVoice: payload.audioAsVoice === true,
        readFile: ctx.readFile,
        localRoots: ctx.localRoots,
      })
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/** True when a value is a SecretRef object rather than a literal string. */
function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as any).id === "string" &&
    typeof (value as any).source === "string"
  );
}

function resolveConfig(cfg: any): WhatsAppCloudConfig {
  const raw = cfg?.channels?.["whatsapp-cloud"] ?? cfg ?? {};
  return {
    enabled: raw.enabled ?? CONFIG_DEFAULTS.enabled ?? true,
    phoneNumberId: String(raw.phoneNumberId ?? ""),
    businessAccountId: String(raw.businessAccountId ?? ""),
    // Secret fields: keep a plaintext string as-is; leave empty when a SecretRef
    // is configured (resolved later by ensureSecretsResolved) and stash the raw
    // value so the resolver can read it.
    accessToken: typeof raw.accessToken === "string" ? raw.accessToken : "",
    appSecret: typeof raw.appSecret === "string" ? raw.appSecret : "",
    // verifyToken: plaintext string used as-is; a SecretRef leaves it empty
    // (resolved later by the native resolver) and stashes the raw value; the
    // default applies only when the field is entirely unset (never for a
    // pending SecretRef, which must resolve to its own value).
    verifyToken:
      typeof raw.verifyToken === "string"
        ? raw.verifyToken
        : raw.verifyToken == null
          ? CONFIG_DEFAULTS.verifyToken!
          : "",
    webhookPort: Number(raw.webhookPort ?? CONFIG_DEFAULTS.webhookPort!),
    webhookPath: String(raw.webhookPath ?? CONFIG_DEFAULTS.webhookPath!),
    apiVersion: String(raw.apiVersion ?? CONFIG_DEFAULTS.apiVersion!),
    dmPolicy: raw.dmPolicy ?? CONFIG_DEFAULTS.dmPolicy!,
    allowFrom: raw.allowFrom ?? CONFIG_DEFAULTS.allowFrom!,
    sendReadReceipts: raw.sendReadReceipts ?? CONFIG_DEFAULTS.sendReadReceipts!,
    downloadInboundMedia: raw.downloadInboundMedia ?? CONFIG_DEFAULTS.downloadInboundMedia!,
    suppressServiceNotices: raw.suppressServiceNotices ?? CONFIG_DEFAULTS.suppressServiceNotices!,
    ...(typeof raw.serviceNoticeReplacement === "string"
      ? { serviceNoticeReplacement: raw.serviceNoticeReplacement }
      : {}),
    ...(Array.isArray(raw.mediaLocalRoots)
      ? { mediaLocalRoots: raw.mediaLocalRoots.filter((r: unknown) => typeof r === "string") }
      : {}),
    _rawAccessToken: raw.accessToken,
    _rawAppSecret: raw.appSecret,
    _rawVerifyToken: raw.verifyToken,
  };
}

// Secret contract lives in ./secret-contract-api so the host can also load it
// as a standalone `secret-contract-api.js` module (its runtime secret resolver
// discovers it by filename, not from the in-memory `secrets` block below).

/**
 * Kept as a no-op: OpenClaw now resolves SecretRefs natively via the secret
 * contract (SECRET_TARGET_REGISTRY_ENTRIES on the channel's `secrets` adapter),
 * so by the time the channel reads config the secret fields are already
 * plaintext. Previously this did a runtime SDK import that could stall channel
 * startup; that path is removed.
 */
async function ensureSecretsResolved(
  _config: WhatsAppCloudConfig,
  _runtime?: any,
  _log?: Logger
): Promise<void> {
  /* no-op: native resolution happens before the channel reads config */
}

/** True when a credential is set, either as plaintext or a SecretRef to resolve. */
function hasCredential(resolved: string, raw: unknown): boolean {
  return Boolean(resolved) || isSecretRef(raw);
}

function resolveAccount(cfg: any, accountId?: string | null): ResolvedWhatsAppCloudAccount {
  const channelCfg = cfg?.channels?.["whatsapp-cloud"] ?? {};
  const config = resolveConfig(cfg);
  return {
    accountId: accountId ?? DEFAULT_ACCOUNT_ID,
    name: channelCfg.name,
    enabled: config.enabled,
    config,
    tokenSource: config.accessToken ? "config" : "none",
  };
}

// ---------------------------------------------------------------------------
// Channel plugin definition
// Follows the ChannelPlugin<ResolvedAccount> interface from OpenClaw SDK
// ---------------------------------------------------------------------------

const whatsappCloudChannel = {
  id: "whatsapp-cloud" as string,

  meta: {
    id: "whatsapp-cloud" as string,
    label: "WhatsApp Cloud API",
    selectionLabel: "WhatsApp (Meta Cloud API)",
    docsPath: "/channels/whatsapp-cloud",
    docsLabel: "whatsapp-cloud",
    blurb:
      "WhatsApp via Meta's official Cloud API. Production-safe for business — no Baileys, no ban risk.",
    aliases: ["wa-cloud", "whatsapp-business", "wa-business"],
    preferOver: ["whatsapp"],
    quickstartAllowFrom: true,
  },

  onboarding: whatsappCloudOnboardingAdapter,

  // Secret contract: tells OpenClaw which config fields are secrets so it
  // resolves SecretRefs natively into the config snapshot before the channel
  // reads them (also surfaces them to `secrets audit`/`configure`).
  secrets: {
    secretTargetRegistryEntries: whatsappCloudSecretContract.secretTargetRegistryEntries as unknown as any[],
    collectRuntimeConfigAssignments: whatsappCloudSecretContract.collectRuntimeConfigAssignments,
  },

  capabilities: {
    chatTypes: ["direct"] as Array<"direct">,
    media: true,
    blockStreaming: true,
  },

  reload: { configPrefixes: ["channels.whatsapp-cloud"] },

  // ---- Config adapter ----
  config: {
    listAccountIds: (cfg: any): string[] =>
      cfg?.channels?.["whatsapp-cloud"]?.enabled !== false ? [DEFAULT_ACCOUNT_ID] : [],

    resolveAccount: (cfg: any, accountId?: string | null): ResolvedWhatsAppCloudAccount =>
      resolveAccount(cfg, accountId),

    defaultAccountId: (_cfg: any): string => DEFAULT_ACCOUNT_ID,

    setAccountEnabled: ({ cfg, accountId, enabled }: { cfg: any; accountId: string; enabled: boolean }): any => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "whatsapp-cloud": {
          ...cfg.channels?.["whatsapp-cloud"],
          enabled,
        },
      },
    }),

    deleteAccount: ({ cfg, accountId }: { cfg: any; accountId: string }): any => {
      const next = { ...cfg };
      const nextChannels = { ...next.channels };
      delete nextChannels["whatsapp-cloud"];
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },

    isConfigured: (account: ResolvedWhatsAppCloudAccount): boolean =>
      hasCredential(account.config.accessToken, account.config._rawAccessToken) &&
      Boolean(account.config.phoneNumberId?.trim()),

    describeAccount: (account: ResolvedWhatsAppCloudAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured:
        hasCredential(account.config.accessToken, account.config._rawAccessToken) &&
        Boolean(account.config.phoneNumberId?.trim()),
      tokenSource: account.tokenSource,
    }),

    resolveAllowFrom: ({ cfg }: { cfg: any; accountId?: string | null }) =>
      (cfg?.channels?.["whatsapp-cloud"]?.allowFrom ?? []).map((entry: any) => String(entry)),

    formatAllowFrom: ({ allowFrom }: { cfg: any; accountId?: string | null; allowFrom: Array<string | number> }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/[^0-9+]/g, "")),
  },

  // ---- Security adapter ----
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }: { cfg: any; accountId?: string | null; account: ResolvedWhatsAppCloudAccount }) => ({
      policy: account.config.dmPolicy ?? "open",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.whatsapp-cloud.dmPolicy",
      allowFromPath: "channels.whatsapp-cloud.",
      approveHint: "openclaw pairing approve whatsapp-cloud <code>",
      normalizeEntry: (raw: string) => raw.replace(/[^0-9]/g, ""),
    }),
  },

  // ---- Pairing ----
  pairing: {
    idLabel: "whatsappPhoneNumber",
    normalizeAllowEntry: (entry: string) => entry.replace(/[^0-9]/g, ""),
    notifyApproval: async ({ cfg, id }: { cfg: any; id: string }) => {
      const config = resolveConfig(cfg);
      await ensureSecretsResolved(config, getWhatsAppCloudRuntime());
      if (!config.accessToken) {
        throw new Error("WhatsApp Cloud access token not configured");
      }
      const log: Logger = console as unknown as Logger;
      await sendText(config, id, "OpenClaw: your access has been approved.", log);
    },
  },

  // ---- Setup adapter (for `openclaw channels login whatsapp-cloud`) ----
  setup: {
    resolveAccountId: ({ accountId }: { cfg: any; accountId?: string }) =>
      accountId ?? DEFAULT_ACCOUNT_ID,

    validateInput: ({ accountId, input }: { cfg: any; accountId: string; input: any }) => {
      if (!input.accessToken && !input.token) {
        return "WhatsApp Cloud API requires an access token. Use --token <access-token>.";
      }
      return null;
    },

    applyAccountConfig: ({ cfg, accountId, input }: { cfg: any; accountId: string; input: any }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "whatsapp-cloud": {
          ...cfg.channels?.["whatsapp-cloud"],
          enabled: true,
          ...(input.name ? { name: input.name } : {}),
          ...(input.accessToken ? { accessToken: input.accessToken } : {}),
          ...(input.token ? { accessToken: input.token } : {}),
          ...(input.webhookPath ? { webhookPath: input.webhookPath } : {}),
          ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
        },
      },
    }),
  },

  // ---- Outbound adapter ----
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4096,
    presentationCapabilities: PRESENTATION_CAPABILITIES,

    // Keep the core-adapted presentation on the payload; sendPayload renders it.
    renderPresentation: ({ payload, presentation }: { payload: any; presentation: any }) => ({
      ...payload,
      presentation,
      channelData: { ...payload.channelData, "whatsapp-cloud": { presentation } },
    }),

    sendPayload: async (ctx: any) => {
      const config = resolveConfig(ctx.cfg);
      const log: Logger = getWhatsAppCloudRuntime()?.logging?.getChildLogger?.({ channel: "whatsapp-cloud" }) ?? console as unknown as Logger;
      await ensureSecretsResolved(config, getWhatsAppCloudRuntime());

      if (!config.accessToken || !config.phoneNumberId) {
        throw new Error("WhatsApp Cloud API not configured: missing accessToken or phoneNumberId");
      }

      const payload = {
        ...ctx.payload,
        replyToId: ctx.payload?.replyToId ?? ctx.replyToId ?? undefined,
        audioAsVoice: ctx.payload?.audioAsVoice ?? ctx.audioAsVoice,
      };
      const results = await deliverPayload(config, ctx.to, payload, log, {
        readFile: ctx.mediaReadFile,
        localRoots: ctx.mediaLocalRoots,
      });
      const sent = results.filter((r) => r.ok);
      // Throw only when nothing went out: a retry after a partial send would
      // duplicate the parts that were delivered.
      if (results.length > 0 && sent.length === 0) {
        throw new Error(`WhatsApp Cloud API send failed: ${results[0]?.error}`);
      }
      for (const r of results) {
        if (!r.ok) log.warn?.(`[whatsapp-cloud] Partial delivery to ${ctx.to}: ${r.error}`);
      }
      return {
        channel: "whatsapp-cloud" as any,
        messageId: sent[sent.length - 1]?.messageId ?? "unknown",
        chatId: ctx.to,
      };
    },

    sendText: async ({ cfg, to, text, accountId, replyToId }: {
      cfg: any;
      to: string;
      text: string;
      mediaUrl?: string;
      replyToId?: string | null;
      threadId?: string | number | null;
      accountId?: string | null;
      deps?: any;
      silent?: boolean;
    }) => {
      const config = resolveConfig(cfg);
      const log: Logger = getWhatsAppCloudRuntime()?.logging?.getChildLogger?.({ channel: "whatsapp-cloud" }) ?? console as unknown as Logger;
      await ensureSecretsResolved(config, getWhatsAppCloudRuntime());

      if (!config.accessToken || !config.phoneNumberId) {
        throw new Error("WhatsApp Cloud API not configured: missing accessToken or phoneNumberId");
      }

      const result = await sendText(config, to, text, log, { replyToId });

      if (!result.ok) {
        throw new Error(`WhatsApp Cloud API send failed: ${result.error}`);
      }

      return {
        channel: "whatsapp-cloud" as any,
        messageId: result.messageId ?? "unknown",
        chatId: to,
      };
    },

    sendMedia: async ({ cfg, to, text, mediaUrl, accountId, replyToId, audioAsVoice, mediaReadFile, mediaLocalRoots }: {
      cfg: any;
      to: string;
      text: string;
      mediaUrl?: string;
      accountId?: string | null;
      replyToId?: string | null;
      audioAsVoice?: boolean;
      mediaReadFile?: (filePath: string) => Promise<Buffer>;
      mediaLocalRoots?: readonly string[];
    }) => {
      const config = resolveConfig(cfg);
      const log: Logger = getWhatsAppCloudRuntime()?.logging?.getChildLogger?.({ channel: "whatsapp-cloud" }) ?? console as unknown as Logger;
      await ensureSecretsResolved(config, getWhatsAppCloudRuntime());

      if (!config.accessToken || !config.phoneNumberId) {
        throw new Error("WhatsApp Cloud API not configured: missing accessToken or phoneNumberId");
      }

      if (mediaUrl) {
        const result = await sendOutboundMedia(config, to, mediaUrl, text || undefined, log, {
          replyToId,
          asVoice: audioAsVoice === true,
          readFile: mediaReadFile,
          localRoots: mediaLocalRoots,
        });
        if (!result.ok) {
          throw new Error(`WhatsApp Cloud API media send failed: ${result.error}`);
        }
        return {
          channel: "whatsapp-cloud" as any,
          messageId: result.messageId ?? "unknown",
          chatId: to,
        };
      }

      // Fallback to text if no media URL
      const result = await sendText(config, to, text, log, { replyToId });
      if (!result.ok) {
        throw new Error(`WhatsApp Cloud API send failed: ${result.error}`);
      }
      return {
        channel: "whatsapp-cloud" as any,
        messageId: result.messageId ?? "unknown",
        chatId: to,
      };
    },
  },

  // ---- Gateway lifecycle ----
  gateway: {
    startAccount: async (ctx: any) => {
      const account: ResolvedWhatsAppCloudAccount = ctx.account;
      const config = account.config;
      const log: Logger = ctx.log ?? console as unknown as Logger;
      const runtime = getWhatsAppCloudRuntime();

      if (!config.enabled) {
        log.info?.("[whatsapp-cloud] Channel is disabled");
        return;
      }

      // Resolve SecretRef-backed credentials (accessToken/appSecret). Bounded by
      // a timeout so a slow/stuck resolver can never hang channel startup; if a
      // ref is configured but not yet resolved here, the send/HMAC paths resolve
      // it lazily per request.
      await ensureSecretsResolved(config, runtime, log);

      // Require credentials to be PRESENT (plaintext or a SecretRef); do not
      // hard-fail on an as-yet-unresolved ref so the webhook can still bind.
      if (!hasCredential(config.accessToken, config._rawAccessToken) || !config.phoneNumberId) {
        log.error("[whatsapp-cloud] Not configured: missing accessToken or phoneNumberId");
        log.error("[whatsapp-cloud] Run 'openclaw channels login whatsapp-cloud' to configure");
        return;
      }
      if (!config.accessToken && isSecretRef(config._rawAccessToken)) {
        log.warn("[whatsapp-cloud] accessToken SecretRef not resolved at startup; will retry per request");
      }
      for (const warn of validateConfig(config).warnings) {
        log.warn(`[whatsapp-cloud] ${warn}`);
      }

      // If the webhook is already mounted on the gateway's shared HTTP server
      // (via api.registerHttpRoute in register()), do NOT open a standalone
      // server — the gateway route handles inbound events on the public tunnel.
      if (gatewayRouteMounted) {
        log.info("[whatsapp-cloud] Channel started (webhook mounted on gateway HTTP server)");
        log.info(`[whatsapp-cloud]   Webhook path: ${config.webhookPath} (served by gateway + public origin)`);
      } else {
        // Fallback: standalone webhook HTTP server on webhookPort
        webhookServer = startWebhookServer(
          config,
          (message) => dispatchInbound(message, config, runtime, account.accountId, log),
          (messageId, status, recipientId) => {
            log.debug?.(`[whatsapp-cloud] Status: ${status} for message ${messageId} to ${recipientId}`);
          },
          log
        );
        log.info("[whatsapp-cloud] Channel started (standalone webhook server)");
        log.info(`[whatsapp-cloud]   Webhook: http://localhost:${config.webhookPort}${config.webhookPath}`);
      }

      log.info(`[whatsapp-cloud]   DM Policy: ${config.dmPolicy}`);
      if (config.dmPolicy === "allowlist") {
        log.info(`[whatsapp-cloud]   Allowed: ${config.allowFrom.join(", ") || "(none)"}`);
      }

      // Update runtime status
      if (typeof ctx.setStatus === "function") {
        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          lastStartAt: Date.now(),
          mode: "webhook",
        });
      }

      // Keep the account alive until the gateway aborts it. Returning early
      // makes the gateway treat the channel as exited and auto-restart it in a
      // loop. On abort, tear down the standalone server (if any).
      const abortSignal: AbortSignal | undefined = ctx.abortSignal;
      if (abortSignal) {
        await new Promise<void>((resolve) => {
          if (abortSignal.aborted) {
            resolve();
            return;
          }
          abortSignal.addEventListener(
            "abort",
            () => {
              if (webhookServer) {
                webhookServer.close();
                webhookServer = null;
              }
              log.info?.("[whatsapp-cloud] Channel stopping (abort signal)");
              resolve();
            },
            { once: true }
          );
        });
      }
    },

    logoutAccount: async ({ accountId, cfg }: { accountId: string; cfg: any }) => {
      // Stop webhook if running
      if (webhookServer) {
        webhookServer.close();
        webhookServer = null;
      }

      // Clear credentials from config
      const nextCfg = { ...cfg };
      const waCloudCfg = cfg.channels?.["whatsapp-cloud"];
      if (waCloudCfg) {
        const { accessToken, appSecret, ...rest } = waCloudCfg;
        nextCfg.channels = {
          ...nextCfg.channels,
          "whatsapp-cloud": rest,
        };

        await getWhatsAppCloudRuntime().config.replaceConfigFile({ nextConfig: nextCfg, afterWrite: { mode: "auto" } });
      }

      return {
        cleared: Boolean(waCloudCfg?.accessToken),
        loggedOut: true,
      };
    },
  },

  // ---- Status adapter ----
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },

    // Receives the snapshots built by buildAccountSnapshot, not resolved accounts.
    collectStatusIssues: (accounts: any[]) => {
      const issues: any[] = [];
      for (const account of accounts) {
        const aid = account.accountId ?? DEFAULT_ACCOUNT_ID;
        if (!account.hasAccessToken) {
          issues.push({
            channel: "whatsapp-cloud",
            accountId: aid,
            kind: "config",
            message: "WhatsApp Cloud API access token not configured",
          });
        }
        if (!account.hasPhoneNumberId) {
          issues.push({
            channel: "whatsapp-cloud",
            accountId: aid,
            kind: "config",
            message: "WhatsApp Cloud API phone number ID not configured",
          });
        }
      }
      return issues;
    },

    buildAccountSnapshot: ({ account, runtime }: { account: ResolvedWhatsAppCloudAccount; cfg: any; runtime?: any }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured:
        hasCredential(account.config.accessToken, account.config._rawAccessToken) &&
        Boolean(account.config.phoneNumberId?.trim()),
      hasAccessToken: hasCredential(account.config.accessToken, account.config._rawAccessToken),
      hasPhoneNumberId: Boolean(account.config.phoneNumberId?.trim()),
      tokenSource: account.tokenSource,
      running: runtime?.running ?? (webhookServer?.listening ?? false),
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      mode: "webhook",
    }),
  },
};

// ---------------------------------------------------------------------------
// Plugin definition (OpenClawPluginDefinition)
// ---------------------------------------------------------------------------

const plugin = {
  id: "openclaw-whatsapp-cloud-api",
  name: "WhatsApp Cloud API",
  description: "WhatsApp Cloud API channel plugin — official Meta Business API, no Baileys",

  register(api: any) {
    const log: Logger = api.logger ?? (console as unknown as Logger);
    log.info("[whatsapp-cloud] Loading WhatsApp Cloud API channel plugin");

    // Store runtime reference for dispatch and config access
    setWhatsAppCloudRuntime(api.runtime);

    // Register the channel
    api.registerChannel({ plugin: whatsappCloudChannel });

    // Optional: mount the webhook on the gateway's shared HTTP server instead of
    // a standalone server. Only enable when the gateway's routes are exposed on
    // a public/webhook-only listener (NOT the loopback operator port, which also
    // serves the dashboard). Opt in via channels.whatsapp-cloud.useGatewayRoute.
    const useGatewayRoute = api.pluginConfig?.useGatewayRoute === true;
    if (useGatewayRoute && typeof api.registerHttpRoute === "function") {
      const routePath =
        (api.pluginConfig?.webhookPath as string | undefined) ??
        CONFIG_DEFAULTS.webhookPath!;
      try {
        api.registerHttpRoute({
          path: routePath,
          auth: "plugin", // plugin validates its own auth (verifyToken + HMAC)
          match: "exact",
          replaceExisting: true,
          handler: async (req: any, res: any): Promise<boolean> => {
            const runtime = api.runtime;
            let config: WhatsAppCloudConfig;
            try {
              config = resolveConfig(runtime.config.current());
            } catch (err) {
              log.error(`[whatsapp-cloud] Failed to load config for webhook: ${err}`);
              res.writeHead(503);
              res.end("Service unavailable");
              return true;
            }
            if (!config.enabled) {
              res.writeHead(503);
              res.end("Channel disabled");
              return true;
            }
            await ensureSecretsResolved(config, runtime);
            return handleWebhookRequest(
              req,
              res,
              config,
              (message) => dispatchInbound(message, config, runtime, DEFAULT_ACCOUNT_ID, log),
              (messageId, status, recipientId) => {
                log.debug?.(`[whatsapp-cloud] Status: ${status} for message ${messageId} to ${recipientId}`);
              },
              log
            );
          },
        });
        gatewayRouteMounted = true;
        log.info(`[whatsapp-cloud] Webhook route mounted on gateway: ${routePath}`);
      } catch (err) {
        log.warn?.(`[whatsapp-cloud] registerHttpRoute failed, will use standalone server: ${err}`);
      }
    }

    // Register CLI commands: `openclaw whatsapp-cloud setup|status|test`
    if (typeof api.registerCli === "function") {
      api.registerCli(
        ({ program }: any) => {
          const cmd = program
            .command("whatsapp-cloud")
            .description("WhatsApp Cloud API channel management");

          cmd
            .command("setup")
            .description("Interactive setup wizard for WhatsApp Cloud API credentials")
            .action(async () => {
              try {
                const result = await runSetupWizard(undefined, log);

                // Save via runtime config
                try {
                  const runtime = getWhatsAppCloudRuntime();
                  const currentCfg = runtime.config.current();
                  const nextCfg = {
                    ...currentCfg,
                    channels: {
                      ...currentCfg.channels,
                      "whatsapp-cloud": {
                        ...currentCfg.channels?.["whatsapp-cloud"],
                        enabled: true,
                        phoneNumberId: result.phoneNumberId,
                        ...(result.businessAccountId ? { businessAccountId: result.businessAccountId } : {}),
                        accessToken: result.accessToken,
                        ...(result.appSecret ? { appSecret: result.appSecret } : {}),
                        verifyToken: result.verifyToken,
                        webhookPort: result.webhookPort,
                        webhookPath: result.webhookPath,
                        dmPolicy: result.dmPolicy,
                      },
                    },
                  };
                  await runtime.config.replaceConfigFile({ nextConfig: nextCfg, afterWrite: { mode: "auto" } });
                  log.info("[whatsapp-cloud] Configuration saved to openclaw.json");
                  console.log("\n  Then: openclaw gateway restart\n");
                } catch {
                  // Fallback: print commands for manual config
                  console.log("\nRun these commands to save your config:\n");
                  console.log(`  openclaw config set channels.whatsapp-cloud.enabled true`);
                  console.log(`  openclaw config set channels.whatsapp-cloud.phoneNumberId "${result.phoneNumberId}"`);
                  console.log(`  openclaw config set channels.whatsapp-cloud.accessToken "${result.accessToken}"`);
                  if (result.appSecret) {
                    console.log(`  openclaw config set channels.whatsapp-cloud.appSecret "${result.appSecret}"`);
                  }
                  console.log(`  openclaw config set channels.whatsapp-cloud.verifyToken "${result.verifyToken}"`);
                  console.log(`  openclaw config set channels.whatsapp-cloud.webhookPort ${result.webhookPort}`);
                  console.log(`\n  Then: openclaw gateway restart\n`);
                }
              } catch (err) {
                log.error(`Setup failed: ${err}`);
                process.exit(1);
              }
            });

          cmd
            .command("status")
            .description("Check WhatsApp Cloud API channel health")
            .action(async () => {
              const standaloneRunning = webhookServer !== null && webhookServer.listening;
              const isRunning = gatewayRouteMounted || standaloneRunning;
              console.log(`WhatsApp Cloud API: ${isRunning ? "OK" : "Not running"}`);
              if (gatewayRouteMounted) {
                console.log(`  Webhook: mounted on gateway HTTP server (public origin)`);
              } else {
                console.log(`  Webhook server: ${standaloneRunning ? "running (standalone)" : "not running"}`);
              }

              try {
                const runtime = getWhatsAppCloudRuntime();
                const cfg = runtime.config.current();
                const config = resolveConfig(cfg);
                await ensureSecretsResolved(config, runtime);
                const validation = validateConfig(config);
                if (!validation.valid) {
                  for (const err of validation.errors) {
                    console.log(`  Config error: ${err}`);
                  }
                }
                for (const warn of validation.warnings) {
                  console.log(`  Warning: ${warn}`);
                }
              } catch {
                console.log("  (could not load config)");
              }
            });

          cmd
            .command("test")
            .description("Send a test message to verify configuration")
            .argument("<phone>", "Recipient phone in E.164 format (e.g., +393491234567)")
            .action(async (phone: string) => {
              try {
                const runtime = getWhatsAppCloudRuntime();
                const cfg = runtime.config.current();
                const config = resolveConfig(cfg);
                await ensureSecretsResolved(config, runtime);

                if (!config.accessToken || !config.phoneNumberId) {
                  log.error("Missing config. Run 'openclaw whatsapp-cloud setup' first.");
                  process.exit(1);
                }

                const result = await sendText(
                  config,
                  phone.replace("+", ""),
                  "Hello from OpenClaw! Your WhatsApp Cloud API channel is working.",
                  log
                );

                if (result.ok) {
                  console.log(`Test message sent to ${phone} (ID: ${result.messageId})`);
                } else {
                  console.log(`Failed: ${result.error}`);
                  process.exit(1);
                }
              } catch (err) {
                log.error(`Test failed: ${err}`);
                process.exit(1);
              }
            });
        },
        {
          descriptors: [
            {
              name: "whatsapp-cloud",
              description: "WhatsApp Cloud API channel management",
              hasSubcommands: true,
            },
          ],
        }
      );
    }

    log.info("[whatsapp-cloud] Plugin registered");
  },
};

export default plugin;

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { sendText, sendTemplate, sendInteractive, sendButtons, sendMedia, uploadMedia } from "./api.js";
export { markAsRead, sendTypingIndicator, getMediaUrl, downloadMedia, isServiceNotice, stripInspectFooter } from "./api.js";
export { extractToneTag, applyToneTag, persistTonePreference, clearTonePreference, resolveTonePrefsDir } from "./tone.js";
export { saveInboundMedia, mediaKindFromMime, resolveInboundMediaDir, sendOutboundMedia, resolveAllowedMediaRoots } from "./media.js";
export { renderPresentationForWhatsApp, inboundTextForChoice } from "./presentation.js";
export { runSetupWizard, validateConfig } from "./setup.js";
export type { WhatsAppCloudConfig } from "./types.js";
export type { ParsedInboundMessage, ParsedInboundMessage as InboundMessage } from "./webhook.js";
export { whatsappCloudOnboardingAdapter } from "./onboarding.js";
