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
import { sendText, sendMedia, sendTypingIndicator } from "./api.js";
import { startWebhookServer, handleWebhookRequest } from "./webhook.js";
import type { ParsedInboundMessage } from "./webhook.js";
import { runSetupWizard, validateConfig } from "./setup.js";
import { whatsappCloudOnboardingAdapter } from "./onboarding.js";
import type { WhatsAppCloudConfig, Logger, SecretRef } from "./types.js";
import { CONFIG_DEFAULTS } from "./types.js";
import { setWhatsAppCloudRuntime, getWhatsAppCloudRuntime } from "./runtime.js";

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
  try {
    // Resolve any SecretRef-backed credentials before using them
    await ensureSecretsResolved(config, runtime);

    // Show typing indicator immediately (auto-dismissed on reply or after 25s)
    sendTypingIndicator(config, message.messageId, log).catch(() => {});

    // Load fresh config for dispatch
    const freshCfg = runtime.config.current();

    // Canonical per-channel-peer session key, matching OpenClaw's own builder:
    //   agent:<agentId>:<channel>:direct:<+e164peer>
    // Must include the channel id ("whatsapp-cloud", NOT "whatsapp"), the
    // "direct" peer-kind segment, and an E.164 peer with a leading "+".
    // Getting this exact shape is what keeps each WhatsApp sender in its own
    // session and prevents collisions with the built-in whatsapp channel's
    // sessions for the same number.
    const agentId = resolveAgentId(freshCfg);
    const peerId = message.from.startsWith("+") ? message.from : `+${message.from}`;
    const sessionKey = `agent:${agentId}:whatsapp-cloud:direct:${peerId}`;

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

    if (message.quotedMessageId) {
      msgCtx.ReplyToId = message.quotedMessageId;
    }

    // Dispatch via OpenClaw's reply system
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: msgCtx,
      cfg: freshCfg,
      dispatcherOptions: {
        deliver: async (payload: any) => {
          if (payload.text) {
            await sendText(config, message.from, payload.text, log);
          }
          if (payload.mediaUrl) {
            await sendMedia(config, message.from, "image", { link: payload.mediaUrl }, log);
          }
          if (payload.mediaUrls?.length) {
            for (const url of payload.mediaUrls) {
              await sendMedia(config, message.from, "image", { link: url }, log);
            }
          }
        },
        onReplyStart: () => {
          log.info?.(`[whatsapp-cloud] Generating reply for ${message.senderName} (${message.from})`);
        },
      },
    });
  } catch (err) {
    log.error(`[whatsapp-cloud] Failed to dispatch inbound message: ${err}`);
  }
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
    verifyToken: String(raw.verifyToken ?? CONFIG_DEFAULTS.verifyToken!),
    webhookPort: Number(raw.webhookPort ?? CONFIG_DEFAULTS.webhookPort!),
    webhookPath: String(raw.webhookPath ?? CONFIG_DEFAULTS.webhookPath!),
    apiVersion: String(raw.apiVersion ?? CONFIG_DEFAULTS.apiVersion!),
    dmPolicy: raw.dmPolicy ?? CONFIG_DEFAULTS.dmPolicy!,
    allowFrom: raw.allowFrom ?? CONFIG_DEFAULTS.allowFrom!,
    sendReadReceipts: raw.sendReadReceipts ?? CONFIG_DEFAULTS.sendReadReceipts!,
    _rawAccessToken: raw.accessToken,
    _rawAppSecret: raw.appSecret,
  };
}

/**
 * Secret-target registry entries: declare accessToken/appSecret (under
 * channels.whatsapp-cloud) as inline SecretInput fields so OpenClaw's own secret
 * resolver reads a SecretRef, resolves it, and injects the plaintext value into
 * the config snapshot BEFORE the channel reads it. This is the native path:
 * exposed via the channel's `secrets` adapter (ChannelSecretsAdapter). No host
 * SDK import is needed (it is not resolvable from the installed package path);
 * these are plain data objects matching SecretTargetRegistryEntry.
 */
const SECRET_TARGET_REGISTRY_ENTRIES = [
  {
    id: "whatsapp-cloud.accessToken",
    targetType: "whatsapp-cloud",
    configFile: "openclaw.json",
    pathPattern: "channels.whatsapp-cloud.accessToken",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
  {
    id: "whatsapp-cloud.appSecret",
    targetType: "whatsapp-cloud",
    configFile: "openclaw.json",
    pathPattern: "channels.whatsapp-cloud.appSecret",
    secretShape: "secret_input",
    expectedResolvedValue: "string",
    includeInPlan: true,
    includeInConfigure: true,
    includeInAudit: true,
  },
] as const;

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
    secretTargetRegistryEntries: SECRET_TARGET_REGISTRY_ENTRIES as unknown as any[],
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
      Boolean(account.config.accessToken?.trim() && account.config.phoneNumberId?.trim()),

    describeAccount: (account: ResolvedWhatsAppCloudAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.config.accessToken?.trim() && account.config.phoneNumberId?.trim()),
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

    sendText: async ({ cfg, to, text, accountId }: {
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

      const result = await sendText(config, to, text, log);

      if (!result.ok) {
        throw new Error(`WhatsApp Cloud API send failed: ${result.error}`);
      }

      return {
        channel: "whatsapp-cloud" as any,
        messageId: result.messageId ?? "unknown",
        chatId: to,
      };
    },

    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }: {
      cfg: any;
      to: string;
      text: string;
      mediaUrl?: string;
      accountId?: string | null;
    }) => {
      const config = resolveConfig(cfg);
      const log: Logger = getWhatsAppCloudRuntime()?.logging?.getChildLogger?.({ channel: "whatsapp-cloud" }) ?? console as unknown as Logger;
      await ensureSecretsResolved(config, getWhatsAppCloudRuntime());

      if (!config.accessToken || !config.phoneNumberId) {
        throw new Error("WhatsApp Cloud API not configured: missing accessToken or phoneNumberId");
      }

      if (mediaUrl) {
        const result = await sendMedia(config, to, "image", { link: mediaUrl, caption: text || undefined }, log);
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
      const result = await sendText(config, to, text, log);
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
      configured: Boolean(account.config.accessToken?.trim() && account.config.phoneNumberId?.trim()),
      hasAccessToken: Boolean(account.config.accessToken?.trim()),
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

export { sendText, sendTemplate, sendInteractive, sendButtons, sendMedia } from "./api.js";
export { markAsRead, sendTypingIndicator, getMediaUrl, downloadMedia } from "./api.js";
export { runSetupWizard, validateConfig } from "./setup.js";
export type { WhatsAppCloudConfig } from "./types.js";
export type { ParsedInboundMessage, ParsedInboundMessage as InboundMessage } from "./webhook.js";
export { whatsappCloudOnboardingAdapter } from "./onboarding.js";
