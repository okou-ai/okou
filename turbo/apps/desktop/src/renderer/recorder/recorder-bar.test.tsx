// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRecorderApi } from "../../desktop-bridge";
import type { DesktopRecorderWindowChoice } from "../../desktop-recorder-types";

interface RecorderStub {
  readonly api: DesktopRecorderApi;
  readonly completeWindowSelection: ReturnType<typeof vi.fn>;
  /** Answers the pending `selectWindow`, the way the picker window does. */
  readonly pick: (choice: DesktopRecorderWindowChoice) => void;
}

function installRecorder(): RecorderStub {
  const completeWindowSelection = vi.fn(async () => {
    return await Promise.resolve();
  });
  let answer: ((choice: DesktopRecorderWindowChoice | null) => void) | null =
    null;
  const api = {
    getCapabilities: async () => {
      return await Promise.resolve({ supportsMicrophone: true });
    },
    selectWindow: async () => {
      return await new Promise<DesktopRecorderWindowChoice | null>(
        (resolve) => {
          answer = resolve;
        },
      );
    },
    completeWindowSelection,
    beginAreaSelection: async () => {
      return await Promise.resolve();
    },
    startCapture: async () => {
      return await Promise.resolve();
    },
    cancel: async () => {
      return await Promise.resolve();
    },
  } as unknown as DesktopRecorderApi;
  vi.stubGlobal("okouDesktopRecorder", api);
  return {
    api,
    completeWindowSelection,
    pick: (choice) => {
      answer?.(choice);
    },
  };
}

/**
 * The bar reads the bridge once when its module loads, so the stub has to be in
 * place before the import rather than before the render.
 */
async function renderBar(): Promise<void> {
  const { RecorderBar } = await import("./recorder-bar");
  render(<RecorderBar />);
  await waitFor(() => {
    expect(screen.getByText("Display")).toBeTruthy();
  });
}

function clickSource(label: string): void {
  const button = screen
    .getByText(label)
    .closest("button") as HTMLButtonElement | null;
  if (!button) {
    throw new Error(`Expected a source button labelled ${label}`);
  }
  button.click();
}

describe("RecorderBar", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("names the window mode after the mode, not the window it landed on", async () => {
    const recorder = installRecorder();
    await renderBar();

    clickSource("Window");
    recorder.pick({ sourceId: "window:9", title: "Menubar" });

    // A window called "Menubar" used to rename the button, so the row read
    // Display / Menubar / Area and looked like three capture modes.
    await waitFor(() => {
      expect(screen.getByText("Menubar")).toBeTruthy();
    });
    expect(screen.getByText("Window")).toBeTruthy();
    const button = screen.getByText("Window").closest("button");
    expect(button?.getAttribute("title")).toBe("Menubar");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
  });

  it("abandons an open window pick when the display is chosen instead", async () => {
    const recorder = installRecorder();
    await renderBar();

    clickSource("Window");
    clickSource("Display");

    // Leaving the pick pending kept the picker floating over everything and
    // surfaced Electron's "reply was never sent" once the bar went away.
    await waitFor(() => {
      expect(recorder.completeWindowSelection).toHaveBeenCalledWith(null);
    });
    expect(
      screen
        .getByText("Display")
        .closest("button")
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("abandons an open window pick when an area is chosen instead", async () => {
    const recorder = installRecorder();
    await renderBar();

    clickSource("Window");
    clickSource("Area");

    await waitFor(() => {
      expect(recorder.completeWindowSelection).toHaveBeenCalledWith(null);
    });
  });
});
