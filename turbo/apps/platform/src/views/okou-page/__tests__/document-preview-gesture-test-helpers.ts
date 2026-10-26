import { createEvent, fireEvent } from "@testing-library/react";
import { expect } from "vitest";

export function expectDocumentPreviewGestures(target: HTMLElement): void {
  for (const ctrlKey of [true, false]) {
    const wheel = createEvent.wheel(target);
    Object.defineProperties(wheel, {
      ctrlKey: { value: ctrlKey },
      deltaY: { value: -20 },
    });
    fireEvent(target, wheel);
    expect(wheel.defaultPrevented).toBe(ctrlKey);
  }

  for (const type of ["gesturestart", "gesturechange"]) {
    const gesture = new Event(type, { bubbles: true, cancelable: true });
    fireEvent(target, gesture);
    expect(gesture.defaultPrevented).toBeTruthy();
  }
}
