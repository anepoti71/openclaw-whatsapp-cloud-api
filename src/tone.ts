// ---------------------------------------------------------------------------
// Per-user tone preferences
// ---------------------------------------------------------------------------
// Natural-language, no slash commands: the agent emits an internal
//   <<TONE: ...>>  (or  <<TONE:CLEAR>>)
// tag on its own line when a user asks to change how it talks. This channel
// strips that tag from the outgoing message (the user never sees it) and
// persists the distilled preference to <stateDir>/tone-prefs/<+E164>.md. The
// bundled tone-pref bootstrap hook injects that file on the user's next session,
// so each WhatsApp number carries its own tone on a single shared agent.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "./types.js";

/** Matches an internal tone tag anywhere in a reply, non-greedy. */
const TONE_TAG_RE = /<<\s*TONE\s*:\s*([\s\S]*?)>>/i;

export interface ToneExtraction {
  /** The reply text with the tone tag removed (what the user should see). */
  cleaned: string;
  /** Distilled tone preference to persist, or null when none was requested. */
  preference: string | null;
  /** True when the user asked to reset to the default tone. */
  clear: boolean;
}

/** Shared tone-preference directory; matches the tone-pref bootstrap hook. */
export function resolveTonePrefsDir(): string {
  const base =
    (process.env.OPENCLAW_STATE_DIR && process.env.OPENCLAW_STATE_DIR.trim()) ||
    path.join(os.homedir(), ".openclaw");
  return path.join(base, "tone-prefs");
}

/** Normalize a WhatsApp number to the "+<digits>" form used for pref filenames. */
function prefFile(number: string): string {
  const digits = String(number).replace(/\D/g, "");
  return path.join(resolveTonePrefsDir(), `+${digits}.md`);
}

/**
 * Extract and strip the internal tone tag from a reply.
 * - `<<TONE: dai del tu, tono spiccio>>` -> preference set
 * - `<<TONE:CLEAR>>` (or empty) -> clear
 * - no tag -> cleaned === original, preference null
 */
export function extractToneTag(text: string): ToneExtraction {
  const match = text.match(TONE_TAG_RE);
  if (!match) return { cleaned: text, preference: null, clear: false };

  const raw = (match[1] ?? "").trim();
  const cleaned = text
    .replace(TONE_TAG_RE, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (raw === "" || /^clear$/i.test(raw)) {
    return { cleaned, preference: null, clear: true };
  }
  return { cleaned, preference: raw, clear: false };
}

/** Persist a tone preference for a number (host-side; the agent never writes). */
export function persistTonePreference(number: string, preference: string, log?: Logger): void {
  try {
    fs.mkdirSync(resolveTonePrefsDir(), { recursive: true });
    fs.writeFileSync(prefFile(number), `${preference.trim()}\n`, "utf8");
    log?.info?.(`[whatsapp-cloud] Saved tone preference for ${number}`);
  } catch (err) {
    log?.error?.(`[whatsapp-cloud] Failed to save tone preference: ${String(err)}`);
  }
}

/** Remove a number's tone preference (reset to default). */
export function clearTonePreference(number: string, log?: Logger): void {
  try {
    fs.rmSync(prefFile(number), { force: true });
    log?.info?.(`[whatsapp-cloud] Cleared tone preference for ${number}`);
  } catch (err) {
    log?.error?.(`[whatsapp-cloud] Failed to clear tone preference: ${String(err)}`);
  }
}

/**
 * Apply tone-tag handling to an outgoing reply: persist/clear the preference
 * keyed by the recipient, and return the text to actually send (tag removed).
 * Returns the original text unchanged when there is no tag.
 */
export function applyToneTag(to: string, text: string, log?: Logger): string {
  const { cleaned, preference, clear } = extractToneTag(text);
  if (clear) clearTonePreference(to, log);
  else if (preference) persistTonePreference(to, preference, log);
  return cleaned;
}
