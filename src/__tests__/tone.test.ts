import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  extractToneTag,
  applyToneTag,
  persistTonePreference,
  clearTonePreference,
  resolveTonePrefsDir,
} from "../tone.js";

let tmpState: string;

beforeEach(() => {
  tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "wa-tone-"));
  process.env.OPENCLAW_STATE_DIR = tmpState;
});

afterEach(() => {
  delete process.env.OPENCLAW_STATE_DIR;
  fs.rmSync(tmpState, { recursive: true, force: true });
});

function prefPath(number: string): string {
  return path.join(resolveTonePrefsDir(), `${number}.md`);
}

describe("extractToneTag", () => {
  it("returns text unchanged when there is no tag", () => {
    const r = extractToneTag("Ciao, come va?");
    expect(r).toEqual({ cleaned: "Ciao, come va?", preference: null, clear: false });
  });

  it("extracts and strips a preference tag", () => {
    const r = extractToneTag("Ok, da ora ti parlo così 👍\n<<TONE: dai del tu, tono spiccio>>");
    expect(r.preference).toBe("dai del tu, tono spiccio");
    expect(r.clear).toBe(false);
    expect(r.cleaned).toBe("Ok, da ora ti parlo così 👍");
    expect(r.cleaned).not.toContain("TONE");
  });

  it("treats CLEAR (any case) as a reset", () => {
    const r = extractToneTag("Torno al tono normale.\n<<TONE:CLEAR>>");
    expect(r.clear).toBe(true);
    expect(r.preference).toBeNull();
    expect(r.cleaned).toBe("Torno al tono normale.");
  });

  it("treats an empty tag as a reset", () => {
    const r = extractToneTag("Fatto <<TONE: >>");
    expect(r.clear).toBe(true);
    expect(r.preference).toBeNull();
  });
});

describe("persist / clear tone preference", () => {
  it("writes the preference file keyed by normalized number", () => {
    persistTonePreference("34677243004", "parla formale");
    expect(fs.existsSync(prefPath("+34677243004"))).toBe(true);
    expect(fs.readFileSync(prefPath("+34677243004"), "utf8")).toContain("parla formale");
  });

  it("normalizes a number that already has a plus", () => {
    persistTonePreference("+34677243004", "x");
    expect(fs.existsSync(prefPath("+34677243004"))).toBe(true);
  });

  it("clears the preference file", () => {
    persistTonePreference("+34677243004", "x");
    clearTonePreference("+34677243004");
    expect(fs.existsSync(prefPath("+34677243004"))).toBe(false);
  });

  it("clear is a no-op when no file exists", () => {
    expect(() => clearTonePreference("+39000000000")).not.toThrow();
  });
});

describe("applyToneTag", () => {
  it("persists the preference and returns cleaned text", () => {
    const out = applyToneTag(
      "34677243004",
      "Ok! <<TONE: tono breve, niente emoji>>"
    );
    expect(out).toBe("Ok!");
    expect(fs.readFileSync(prefPath("+34677243004"), "utf8")).toContain("tono breve");
  });

  it("clears the preference on a CLEAR tag", () => {
    persistTonePreference("+34677243004", "old");
    const out = applyToneTag("34677243004", "Torno normale. <<TONE:CLEAR>>");
    expect(out).toBe("Torno normale.");
    expect(fs.existsSync(prefPath("+34677243004"))).toBe(false);
  });

  it("passes normal replies through untouched and writes nothing", () => {
    const out = applyToneTag("34677243004", "Ecco la risposta.");
    expect(out).toBe("Ecco la risposta.");
    expect(fs.existsSync(prefPath("+34677243004"))).toBe(false);
  });
});
