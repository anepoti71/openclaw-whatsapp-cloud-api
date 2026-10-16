// ---------------------------------------------------------------------------
// Channel secret contract API — loaded by OpenClaw's runtime secret resolver.
//
// The host discovers this module by filename (`secret-contract-api.js` at the
// plugin's dist/ root), NOT from the channel plugin's in-memory `secrets`
// block. It imports this module and reads the named exports below. Without the
// `collectRuntimeConfigAssignments` export the host never substitutes resolved
// values for the SecretRefs, so the channel starts with an empty access token,
// HMAC verification disabled, and a missing verify token (Meta token mismatch).
//
// `channel-only` mode: accessToken/appSecret/verifyToken live at the channel
// root (channels.whatsapp-cloud.<field>), not per sub-account.
// ---------------------------------------------------------------------------

import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const contract = createSimpleChannelSecretContract({
  channelKey: "whatsapp-cloud",
  label: "WhatsApp Cloud API",
  accountFields: [],
  channelFields: ["accessToken", "appSecret", "verifyToken"],
  mode: "channel-only",
});

export const secretTargetRegistryEntries = contract.secretTargetRegistryEntries;
export const collectRuntimeConfigAssignments = contract.collectRuntimeConfigAssignments;
export const channelSecrets = contract;
