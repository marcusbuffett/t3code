import type { PointerEvent } from "react";

/**
 * Keep the editor focused when a composer control is pressed with a mouse or
 * pen. Touch is deliberately left alone: iOS Safari drops the synthesized
 * `click` when `pointerdown` is cancelled, so the control would show its
 * pressed state without ever acting. Tapping therefore blurs the editor like
 * any other button; {@link shouldSkipComposerCollapse} keeps that blur from
 * collapsing the phone composer mid-tap.
 */
export function preventPointerFocus(event: PointerEvent<HTMLElement>): void {
  if (event.pointerType === "touch") return;
  event.preventDefault();
}

/** How long after a press inside the composer a blur is attributed to that press. */
export const COMPOSER_POINTER_BLUR_GRACE_MS = 400;

/**
 * A blur that arrives right after a press inside the composer belongs to that
 * press, not to the user leaving the composer. Such a blur must not collapse
 * the phone composer: the pressed control (send, attach, model picker) is
 * still in the middle of acting.
 */
export function shouldSkipComposerCollapse(lastPointerDownAt: number | null, now: number): boolean {
  return lastPointerDownAt !== null && now - lastPointerDownAt < COMPOSER_POINTER_BLUR_GRACE_MS;
}
