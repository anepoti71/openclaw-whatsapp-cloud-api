// ---------------------------------------------------------------------------
// Message presentation → WhatsApp interactive messages
// ---------------------------------------------------------------------------
// OpenClaw's portable `presentation` (title, text, buttons, selects, tables…)
// is mapped to the closest WhatsApp shape:
//   - up to 3 choices          → interactive "button" (reply buttons)
//   - 4–10 choices or a select → interactive "list"
//   - no choices               → plain text
// URL buttons become "label: url" lines (WhatsApp reply buttons cannot open
// links). Choice ids carry the action so the inbound tap can be mapped back:
// `cmd:<command>` runs the command, `cb:<value>`/`opt:<label>` reach the agent
// as the tapped label.
// ---------------------------------------------------------------------------

import type { InteractiveMessage } from "./types.js";

/** Minimal local mirror of OpenClaw's MessagePresentation (no SDK dependency). */
export interface Presentation {
  title?: string;
  blocks: Array<Record<string, any>>;
}

export interface RenderedPresentation {
  /** Text to send before (or instead of) the interactive message. */
  text?: string;
  interactive?: InteractiveMessage;
}

/** WhatsApp limits for interactive messages. */
export const WA_LIMITS = {
  replyButtons: 3,
  buttonTitle: 20,
  listRows: 10,
  rowTitle: 24,
  listButton: 20,
  header: 60,
  body: 1024,
  id: 200,
} as const;

/** Capabilities advertised to OpenClaw core so it adapts presentations first. */
export const PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: false,
  divider: false,
  charts: false,
  tables: false,
  limits: {
    actions: {
      maxActions: WA_LIMITS.listRows,
      maxLabelLength: WA_LIMITS.rowTitle,
      maxValueBytes: WA_LIMITS.id - 4,
      supportsStyles: false,
      supportsDisabled: false,
    },
    selects: {
      maxOptions: WA_LIMITS.listRows,
      maxLabelLength: WA_LIMITS.rowTitle,
      maxValueBytes: WA_LIMITS.id - 4,
    },
    text: { maxLength: WA_LIMITS.body, encoding: "characters" as const, markdownDialect: "plain" as const },
  },
};

const LIST_BUTTON_DEFAULT = "☰ Menu";

interface Choice {
  id: string;
  title: string;
}

function choiceId(action: any, value: unknown, label: string): string {
  let id: string;
  if (action?.type === "command" && typeof action.command === "string") id = `cmd:${action.command}`;
  else if (action?.type === "callback" && typeof action.value === "string") id = `cb:${action.value}`;
  else if (typeof value === "string" && value) id = `cb:${value}`;
  else id = `opt:${label}`;
  return id.slice(0, WA_LIMITS.id);
}

function linkOf(button: any): string | undefined {
  const a = button.action;
  if (a?.type === "url" && typeof a.url === "string") return a.url;
  if (a?.type === "web-app" && typeof a.url === "string") return a.url;
  return button.url ?? button.webApp?.url ?? button.web_app?.url;
}

function tableLines(block: any): string[] {
  const headers: string[] = block.headers ?? [];
  const rows: unknown[][] = block.rows ?? [];
  return [
    `*${block.caption ?? ""}*`,
    ...rows.map((row) => "- " + headers.map((h, i) => `${h}: ${row[i]}`).join("; ")),
  ];
}

function chartLines(block: any): string[] {
  const lines = [`*${block.title ?? ""}*`];
  if (block.chartType === "pie") {
    for (const s of block.segments ?? []) lines.push(`- ${s.label}: ${s.value}`);
  } else {
    const categories: string[] = block.categories ?? [];
    for (const series of block.series ?? []) {
      lines.push(`${series.name}: ` + categories.map((c, i) => `${c} ${series.values?.[i]}`).join(", "));
    }
  }
  return lines;
}

/** Render a presentation into WhatsApp text and/or an interactive message. */
export function renderPresentationForWhatsApp(presentation: Presentation): RenderedPresentation {
  const lines: string[] = [];
  const choices: Choice[] = [];
  let listButton: string | undefined;

  const title = presentation.title?.trim();
  const useHeader = !!title && title.length <= WA_LIMITS.header;
  if (title && !useHeader) lines.push(`*${title}*`);

  for (const block of presentation.blocks ?? []) {
    switch (block.type) {
      case "text":
      case "context":
        if (block.text) lines.push(String(block.text));
        break;
      case "divider":
        lines.push("———");
        break;
      case "table":
        lines.push(...tableLines(block));
        break;
      case "chart":
        lines.push(...chartLines(block));
        break;
      case "buttons":
        for (const button of block.buttons ?? []) {
          if (!button?.label || button.disabled) continue;
          const link = linkOf(button);
          if (link) lines.push(`${button.label}: ${link}`);
          else choices.push({ id: choiceId(button.action, button.value, button.label), title: button.label });
        }
        break;
      case "select":
        listButton ??= block.placeholder;
        for (const option of block.options ?? []) {
          if (!option?.label) continue;
          choices.push({ id: choiceId(option.action, option.value, option.label), title: option.label });
        }
        break;
    }
  }

  let body = lines.join("\n").trim();

  if (choices.length === 0) {
    const text = [useHeader ? `*${title}*` : "", body].filter(Boolean).join("\n");
    return text ? { text } : {};
  }

  // Body is required and capped; overflow goes out as a separate text first.
  let text: string | undefined;
  if (body.length > WA_LIMITS.body) {
    text = body;
    body = "👇";
  }
  if (!body) body = useHeader ? "👇" : title || "👇";

  const header = useHeader ? { header: { type: "text" as const, text: title! } } : {};
  const unique = dedupeIds(choices);

  if (unique.length <= WA_LIMITS.replyButtons && listButton === undefined) {
    return {
      text,
      interactive: {
        type: "button",
        ...header,
        body: { text: body },
        action: {
          buttons: unique.map((c) => ({
            type: "reply" as const,
            reply: { id: c.id, title: c.title.slice(0, WA_LIMITS.buttonTitle) },
          })),
        },
      },
    };
  }

  return {
    text,
    interactive: {
      type: "list",
      ...header,
      body: { text: body },
      action: {
        button: (listButton || LIST_BUTTON_DEFAULT).slice(0, WA_LIMITS.listButton),
        sections: [
          {
            title: (title || "Options").slice(0, WA_LIMITS.rowTitle),
            rows: unique.slice(0, WA_LIMITS.listRows).map((c) => ({
              id: c.id,
              title: c.title.slice(0, WA_LIMITS.rowTitle),
            })),
          },
        ],
      },
    },
  };
}

/** WhatsApp rejects duplicate reply ids; suffix repeats. */
function dedupeIds(choices: Choice[]): Choice[] {
  const seen = new Map<string, number>();
  return choices.map((c) => {
    const n = seen.get(c.id) ?? 0;
    seen.set(c.id, n + 1);
    return n === 0 ? c : { ...c, id: `${c.id}#${n}`.slice(0, WA_LIMITS.id) };
  });
}

/**
 * Map a tapped reply id back to the text the agent should receive: a command
 * for `cmd:` ids, otherwise the visible label.
 */
export function inboundTextForChoice(id: string, title: string): string {
  if (id.startsWith("cmd:")) return id.slice(4).replace(/#\d+$/, "");
  return title;
}
