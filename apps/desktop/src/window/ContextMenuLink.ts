import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronShell from "../electron/ElectronShell.ts";

const CONTEXT_MENU_LINK_WORLD_ID = 1003;
const MAX_TEXT_URL_LENGTH = 2048;
const POINT_LOOKUP_TIMEOUT_MS = 150;

const LEADING_WRAPPERS = new Set(['"', "'", "`", "<", "(", "[", "{"]);
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", '"', "'", "`", ">"]);
const MATCHING_OPENERS: Readonly<Record<string, string>> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

function countChar(text: string, target: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === target) count += 1;
  }
  return count;
}

function trimUrlCandidate(raw: string): string {
  let start = 0;
  let end = raw.length;

  while (start < end && LEADING_WRAPPERS.has(raw[start]!)) {
    start += 1;
  }

  while (end > start) {
    const last = raw[end - 1]!;
    if (TRAILING_PUNCTUATION.has(last)) {
      end -= 1;
      continue;
    }
    const opener = MATCHING_OPENERS[last];
    if (opener !== undefined) {
      const slice = raw.slice(start, end);
      if (countChar(slice, last) > countChar(slice, opener)) {
        end -= 1;
        continue;
      }
    }
    break;
  }

  return raw.slice(start, end);
}

function normalizeUrlCandidate(candidate: string): string | null {
  if (candidate.length === 0 || candidate.length > MAX_TEXT_URL_LENGTH || /\s/.test(candidate)) {
    return null;
  }
  if (/^https?:\/\//i.test(candidate)) {
    return candidate;
  }
  if (/^www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#].*)?$/i.test(candidate)) {
    return `https://${candidate}`;
  }
  if (/^localhost:\d+(?:[/?#].*)?$/i.test(candidate)) {
    return `http://${candidate}`;
  }
  if (/^(?:\d{1,3}\.){3}\d{1,3}:\d+(?:[/?#].*)?$/.test(candidate)) {
    return `http://${candidate}`;
  }
  return null;
}

export function parseContextMenuTextUrl(rawText: string): Option.Option<string> {
  const trimmed = rawText.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TEXT_URL_LENGTH || /\s/.test(trimmed)) {
    return Option.none();
  }
  const normalized = normalizeUrlCandidate(trimUrlCandidate(trimmed));
  if (normalized === null) {
    return Option.none();
  }
  return ElectronShell.parseWebExternalUrl(normalized);
}

function buildPointProbeScript(clientX: number, clientY: number): string {
  return `(() => {
    const x = ${JSON.stringify(clientX)};
    const y = ${JSON.stringify(clientY)};
    let targetNode = null;
    let targetOffset = 0;
    if (typeof document.caretPositionFromPoint === "function") {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos) {
        targetNode = pos.offsetNode;
        targetOffset = pos.offset;
      }
    } else if (typeof document.caretRangeFromPoint === "function") {
      const range = document.caretRangeFromPoint(x, y);
      if (range) {
        targetNode = range.startContainer;
        targetOffset = range.startOffset;
      }
    }
    if (!targetNode || targetNode.nodeType !== Node.TEXT_NODE) return null;

    let container = targetNode.parentElement;
    while (container && container !== document.body && container !== document.documentElement) {
      if (container.classList.contains("line")) break;
      const display = getComputedStyle(container).display;
      if (display && display !== "inline" && display !== "contents") break;
      container = container.parentElement;
    }
    if (!container) return null;

    const segments = [];
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let totalLength = 0;
    let caretGlobalOffset = -1;
    let current = walker.nextNode();
    while (current) {
      const value = current.nodeValue || "";
      if (current === targetNode) {
        caretGlobalOffset = totalLength + targetOffset;
      }
      if (value.length > 0) {
        segments.push({ node: current, start: totalLength, end: totalLength + value.length });
        totalLength += value.length;
      }
      if ((totalLength > 20000 && caretGlobalOffset >= 0) || segments.length >= 5000) break;
      current = walker.nextNode();
    }
    if (caretGlobalOffset < 0 || totalLength === 0) return null;

    const fullText = segments.map((segment) => segment.node.nodeValue || "").join("");
    const lineStart =
      caretGlobalOffset === 0 ? 0 : fullText.lastIndexOf("\\n", caretGlobalOffset - 1) + 1;
    const nextNewline = fullText.indexOf("\\n", caretGlobalOffset);
    const lineEnd = nextNewline === -1 ? fullText.length : nextNewline;
    const lineText = fullText.slice(lineStart, lineEnd);
    const offsetInLine = caretGlobalOffset - lineStart;

    const trailingPunct = new Set([".", ",", ";", ":", "!", "?", '"', "'", "\`", ">"]);
    const openers = { ")": "(", "]": "[", "}": "{" };
    const countChar = (str, ch) => {
      let c = 0;
      for (let i = 0; i < str.length; i += 1) if (str[i] === ch) c += 1;
      return c;
    };

    const re = /(?:https?:\\/\\/|www\\.|localhost:\\d+|(?:\\d{1,3}\\.){3}\\d{1,3}:\\d+)[^\\s"'\`<>]+/gi;
    for (const match of lineText.matchAll(re)) {
      const raw = match[0];
      const idx = match.index;
      if (idx > 0) {
        const prev = lineText[idx - 1];
        const invalid = /^https?:\\/\\//i.test(raw)
          ? /[A-Za-z0-9]/.test(prev)
          : /[A-Za-z0-9_.-]/.test(prev);
        if (invalid) continue;
      }
      let end = raw.length;
      while (end > 0) {
        const last = raw[end - 1];
        if (trailingPunct.has(last)) {
          end -= 1;
          continue;
        }
        const opener = openers[last];
        if (opener) {
          const slice = raw.slice(0, end);
          if (countChar(slice, last) > countChar(slice, opener)) {
            end -= 1;
            continue;
          }
        }
        break;
      }
      const matchStart = idx;
      const matchEnd = idx + end;
      if (offsetInLine < matchStart || offsetInLine > matchEnd) continue;

      const absStart = lineStart + matchStart;
      const absEnd = lineStart + matchEnd;
      const startSeg = segments.find((s) => absStart >= s.start && absStart < s.end);
      const endSeg = segments.find((s) => absEnd > s.start && absEnd <= s.end);
      if (!startSeg || !endSeg) continue;

      const range = document.createRange();
      range.setStart(startSeg.node, absStart - startSeg.start);
      range.setEnd(endSeg.node, absEnd - endSeg.start);
      const pad = 4;
      const hit = Array.from(range.getClientRects()).some(
        (r) =>
          r.width > 0 &&
          r.height > 0 &&
          x >= r.left - pad &&
          x <= r.right + pad &&
          y >= r.top - pad &&
          y <= r.bottom + pad,
      );
      if (hit) {
        return raw.slice(0, end);
      }
    }
    return null;
  })()`;
}

export function canResolveContextMenuTextLinkAtPoint(
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): boolean {
  return (
    !contents.isDestroyed() &&
    typeof contents.executeJavaScriptInIsolatedWorld === "function" &&
    typeof params.x === "number" &&
    typeof params.y === "number" &&
    (!params.frame || params.frame === contents.mainFrame)
  );
}

export function resolveContextMenuTextLinkAtPoint(
  contents: Electron.WebContents,
  params: Electron.ContextMenuParams,
): Effect.Effect<Option.Option<string>> {
  if (!canResolveContextMenuTextLinkAtPoint(contents, params)) {
    return Effect.succeedNone;
  }

  const rawZoom = typeof contents.getZoomFactor === "function" ? contents.getZoomFactor() : 1;
  const zoomFactor = Number.isFinite(rawZoom) && rawZoom > 0 ? rawZoom : 1;
  const clientX = params.x / zoomFactor;
  const clientY = params.y / zoomFactor;

  return Effect.promise(() =>
    contents
      .executeJavaScriptInIsolatedWorld(CONTEXT_MENU_LINK_WORLD_ID, [
        { code: buildPointProbeScript(clientX, clientY) },
      ])
      .catch(() => null),
  ).pipe(
    Effect.timeoutOption(POINT_LOOKUP_TIMEOUT_MS),
    Effect.map((candidate) =>
      Option.flatMap(candidate, (value) =>
        typeof value === "string" ? parseContextMenuTextUrl(value) : Option.none(),
      ),
    ),
  );
}
