# OpenClaw WhatsApp Cloud API Channel

A WhatsApp channel for [OpenClaw](https://github.com/openclaw/openclaw) built on
Meta's **official WhatsApp Cloud API** (`graph.facebook.com`). No Baileys, no
unofficial reverse-engineering, no ban risk. Built for business use.

Package: `@anepoti71/openclaw-whatsapp-cloud-api`

## Features

- **Official Meta Cloud API** — production-safe, no account-ban risk.
- **Setup wizard** — `openclaw whatsapp-cloud setup` walks through every field.
- **Inbound messages** — text, images, **voice notes (transcribed)**, video,
  documents, stickers, location, contacts, interactive replies, quoted messages.
- **Inbound media understanding** — voice notes are transcribed and images read,
  so the agent gets real content instead of a placeholder (`downloadInboundMedia`).
- **Outbound messages** — text (auto-split at 4096 chars), interactive buttons
  and lists, media (image/audio/video/document), template messages, read receipts,
  typing indicator.
- **Per-user tone** — each WhatsApp number sets its own reply tone in plain
  language ("dammi del tu", "sii più breve", "rispondi in spagnolo"). No commands.
- **Service-notice suppression** — OpenClaw's own error/fallback notices are never
  relayed to users (`suppressServiceNotices`).
- **Webhook security** — HMAC-SHA256 signature verification, timing-safe.
- **Access control** — DM policy `open` or `allowlist`.
- **Native secrets** — `accessToken` / `appSecret` resolved from OpenClaw SecretRefs.

## Install

```bash
openclaw plugins install @anepoti71/openclaw-whatsapp-cloud-api
openclaw whatsapp-cloud setup
```

The wizard asks for: Phone Number ID, Business Account ID, access token, app
secret, verify token, webhook port. Point your Meta webhook at
`https://<your-host><webhookPath>` (default `/webhook/whatsapp-cloud`).

## CLI

```bash
openclaw whatsapp-cloud setup     # interactive configuration
openclaw whatsapp-cloud status    # show channel status
openclaw whatsapp-cloud test      # send a test message
```

## Configuration

All config lives under `channels.whatsapp-cloud` in `~/.openclaw/openclaw.json`:

```json
{
  "channels": {
    "whatsapp-cloud": {
      "enabled": true,
      "phoneNumberId": "123456789012345",
      "accessToken": "EAAx...",
      "appSecret": "abc123...",
      "verifyToken": "my-verify-token",
      "webhookPort": 3100,
      "dmPolicy": "allowlist",
      "allowFrom": ["+34600000000"],
      "sendReadReceipts": true,
      "downloadInboundMedia": true,
      "suppressServiceNotices": true
    }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the channel |
| `phoneNumberId` | string | *required* | WhatsApp Phone Number ID |
| `businessAccountId` | string | — | WhatsApp Business Account ID |
| `accessToken` | string | *required* | Meta access token (or a SecretRef) |
| `appSecret` | string | — | Meta App Secret for webhook signature verification |
| `verifyToken` | string | `openclaw-wa-cloud-verify` | Webhook verification token |
| `webhookPort` | number | `3100` | HTTP port for the webhook server |
| `webhookPath` | string | `/webhook/whatsapp-cloud` | Webhook URL path |
| `apiVersion` | string | `v21.0` | Meta Graph API version |
| `dmPolicy` | string | `open` | `open` (anyone) or `allowlist` (restricted) |
| `allowFrom` | string[] | `[]` | E.164 numbers allowed when `dmPolicy=allowlist` |
| `sendReadReceipts` | boolean | `true` | Auto-mark incoming messages as read |
| `downloadInboundMedia` | boolean | `true` | Download + attach inbound media so audio is transcribed and images are read |
| `suppressServiceNotices` | boolean | `true` | Never relay OpenClaw's own service/fallback notices to users |
| `serviceNoticeReplacement` | string | — | Optional text sent instead of a suppressed service notice |

### Voice notes

Inbound voice notes are transcribed through OpenClaw's media-understanding
pipeline (default model `gpt-4o-transcribe`), which requires an audio model to be
available to the agent (an OpenAI API key, or a local STT). The channel only
downloads and attaches the audio; the model does the transcription.

## The 24-hour window

WhatsApp allows free-form replies for 24 hours after a user's message; after that,
only pre-approved template messages. This channel handles free-form replies
automatically; use templates for proactive notifications.

## Development

```bash
git clone https://github.com/anepoti71/openclaw-whatsapp-cloud-api.git
cd openclaw-whatsapp-cloud-api
npm install
npm run type-check    # TypeScript strict mode
npm test              # vitest
npm run build         # compile to dist/
```

## License

MIT. Fork of the original by Baia Digitale SRL; maintained by Alessandro Nepoti.
See [LICENSE](LICENSE).
