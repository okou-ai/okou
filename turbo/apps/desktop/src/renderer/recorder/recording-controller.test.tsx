// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRecorderApi } from "../../desktop-bridge";
import type {
  DesktopRecorderState,
  DesktopRecorderStatus,
} from "../../desktop-recorder-types";

function stateWith(status: DesktopRecorderStatus): DesktopRecorderState {
  return {
    available: true,
    status,
    sessionId: "session-1",
    elapsedMs: 83_000,
    error: null,
    lastRecording: null,
  };
}

/** Installs a bridge whose reported status the test can move. */
function installRecorder(initial: DesktopRecorderStatus): {
  readonly setStatus: (status: DesktopRecorderStatus) => void;
} {
  let status = initial;
  const api = {
    getState: async () => {
      return await Promise.resolve(stateWith(status));
    },
    pause: async () => {
      return await Promise.resolve();
    },
    resume: async () => {
      return await Promise.resolve();
    },
    stop: async () => {
      return await Promise.resolve();
    },
    discard: async () => {
      return await Promise.resolve();
    },
  } as unknown as DesktopRecorderApi;
  vi.stubGlobal("okouDesktopRecorder", api);
  return {
    setStatus: (next) => {
      status = next;
    },
  };
}

/** The controller reads the bridge when its module loads, so stub first. */
async function renderController(): Promise<void> {
  const { RecordingController } = await import("./recording-controller");
  render(<RecordingController />);
}

function button(label: string): HTMLButtonElement {
  return screen.getByLabelText(label) as HTMLButtonElement;
}

describe("RecordingController", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the clock and live controls while recording", async () => {
    installRecorder("recording");
    await renderController();

    await waitFor(() => {
      expect(screen.getByText("01:23")).toBeTruthy();
    });
    expect(button("Pause").disabled).toBe(false);
    expect(button("Finish recording").disabled).toBe(false);
  });

  it("stays up through the finish and says what it is doing", async () => {
    // Vanishing the instant Stop was pressed, seconds before the movie was
    // finalized and uploaded, read as the recorder having quit.
    const recorder = installRecorder("recording");
    await renderController();
    await waitFor(() => {
      expect(screen.getByText("01:23")).toBeTruthy();
    });

    recorder.setStatus("finalizing");
    await waitFor(() => {
      expect(screen.getByText("Finishing…")).toBeTruthy();
    });
    expect(button("Pause").disabled).toBe(true);
    expect(button("Finish recording").disabled).toBe(true);
    expect(button("Delete recording").disabled).toBe(true);

    recorder.setStatus("delivering");
    await waitFor(() => {
      expect(screen.getByText("Uploading…")).toBeTruthy();
    });
  });
});
