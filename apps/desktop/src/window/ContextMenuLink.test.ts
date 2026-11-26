import { describe, expect, it } from "@effect/vitest";
import type * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import {
  canResolveContextMenuTextLinkAtPoint,
  parseContextMenuTextUrl,
  resolveContextMenuTextLinkAtPoint,
} from "./ContextMenuLink.ts";

describe("parseContextMenuTextUrl", () => {
  it.each([
    ["https://example.com/path?a=1#frag", "https://example.com/path?a=1#frag"],
    ["  http://localhost:3000/settings  ", "http://localhost:3000/settings"],
    ['"https://github.com/org/repo/pull/42",', "https://github.com/org/repo/pull/42"],
    ["`https://example.com/docs`.", "https://example.com/docs"],
    ["<https://example.com/docs>;", "https://example.com/docs"],
    ["(https://en.wikipedia.org/wiki/Foo_(bar))", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ["www.example.com/foo", "https://www.example.com/foo"],
    ["localhost:5173/threads", "http://localhost:5173/threads"],
    ["127.0.0.1:8080/health", "http://127.0.0.1:8080/health"],
  ])("parses %s as %s", (input, expected) => {
    expect(parseContextMenuTextUrl(input)).toEqual(Option.some(expected));
  });

  it.each([
    "",
    "   ",
    "params.selectionText",
    "package.json",
    "index.ts",
    "https://example.com extra text",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "vscode://file/tmp/a.ts",
    "mailto:test@example.com",
    "www.notadomain",
    "999.999.999.999:8080",
  ])("rejects non-web text %j", (input) => {
    expect(parseContextMenuTextUrl(input)).toEqual(Option.none());
  });
});

describe("resolveContextMenuTextLinkAtPoint", () => {
  it.effect("scales click coordinates by zoom factor and validates the returned URL", () =>
    Effect.gen(function* () {
      const mainFrame = {};
      const executeJavaScriptInIsolatedWorld = vi.fn(async () => "www.example.com/docs)");
      const contents = {
        isDestroyed: () => false,
        getZoomFactor: () => 1.5,
        mainFrame,
        executeJavaScriptInIsolatedWorld,
      } as unknown as Electron.WebContents;
      const params = {
        x: 150,
        y: 300,
        frame: mainFrame,
      } as unknown as Electron.ContextMenuParams;

      expect(canResolveContextMenuTextLinkAtPoint(contents, params)).toBe(true);
      const result = yield* resolveContextMenuTextLinkAtPoint(contents, params);
      expect(result).toEqual(Option.some("https://www.example.com/docs"));
      expect(executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
      const call = executeJavaScriptInIsolatedWorld.mock.calls[0] as unknown as [
        number,
        Array<{ code: string }>,
      ];
      expect(call[1][0]?.code).toContain("const x = 100;");
      expect(call[1][0]?.code).toContain("const y = 200;");
    }),
  );

  it.effect("ignores subframes and rejects unsafe URLs from the renderer", () =>
    Effect.gen(function* () {
      const mainFrame = {};
      const subFrame = {};
      const executeJavaScriptInIsolatedWorld = vi.fn(async () => "file:///etc/passwd");
      const contents = {
        isDestroyed: () => false,
        getZoomFactor: () => 1,
        mainFrame,
        executeJavaScriptInIsolatedWorld,
      } as unknown as Electron.WebContents;

      expect(
        canResolveContextMenuTextLinkAtPoint(contents, {
          x: 10,
          y: 20,
          frame: subFrame,
        } as unknown as Electron.ContextMenuParams),
      ).toBe(false);

      const unsafe = yield* resolveContextMenuTextLinkAtPoint(contents, {
        x: 10,
        y: 20,
        frame: mainFrame,
      } as unknown as Electron.ContextMenuParams);
      expect(unsafe).toEqual(Option.none());
    }),
  );

  it.effect("returns none when the isolated-world lookup rejects", () =>
    Effect.gen(function* () {
      const mainFrame = {};
      const contents = {
        isDestroyed: () => false,
        getZoomFactor: () => 1,
        mainFrame,
        executeJavaScriptInIsolatedWorld: vi.fn(async () => {
          throw new Error("renderer crashed");
        }),
      } as unknown as Electron.WebContents;

      const result = yield* resolveContextMenuTextLinkAtPoint(contents, {
        x: 10,
        y: 20,
        frame: mainFrame,
      } as unknown as Electron.ContextMenuParams);
      expect(result).toEqual(Option.none());
    }),
  );
});
