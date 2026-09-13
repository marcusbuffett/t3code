import { describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_POINTER_BLUR_GRACE_MS,
  preventPointerFocus,
  shouldSkipComposerCollapse,
} from "./composerPointerFocus";

const pointerEvent = (pointerType: string) => {
  const preventDefault = vi.fn();
  return { event: { pointerType, preventDefault } as never, preventDefault };
};

describe("preventPointerFocus", () => {
  it("keeps focus for mouse and pen presses", () => {
    for (const type of ["mouse", "pen"]) {
      const { event, preventDefault } = pointerEvent(type);
      preventPointerFocus(event);
      expect(preventDefault).toHaveBeenCalledOnce();
    }
  });

  it("lets touch presses complete so iOS Safari still fires click", () => {
    const { event, preventDefault } = pointerEvent("touch");
    preventPointerFocus(event);
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe("shouldSkipComposerCollapse", () => {
  it("attributes a blur shortly after a press inside the composer to that press", () => {
    expect(shouldSkipComposerCollapse(1_000, 1_000 + COMPOSER_POINTER_BLUR_GRACE_MS - 1)).toBe(
      true,
    );
  });

  it("collapses when the blur is unrelated to a recent press", () => {
    expect(shouldSkipComposerCollapse(null, 5_000)).toBe(false);
    expect(shouldSkipComposerCollapse(1_000, 1_000 + COMPOSER_POINTER_BLUR_GRACE_MS)).toBe(false);
  });
});
