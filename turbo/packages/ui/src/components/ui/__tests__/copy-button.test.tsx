import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "../copy-button";

function deferredCopy() {
  let resolveCopy: (copied: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolveCopy = resolve;
  });
  return {
    promise,
    resolve: (copied: boolean) => {
      resolveCopy(copied);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CopyButton", () => {
  it("confirms a successful custom copy using the supplied content", async () => {
    const copyAction = vi.fn<() => Promise<boolean>>(() => {
      return Promise.resolve(true);
    });
    render(
      <CopyButton
        copyAction={copyAction}
        render={({ onClick, ref }, { copied }) => {
          return (
            <button ref={ref} onClick={onClick}>
              {copied ? "copied!" : "/newbot"}
            </button>
          );
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "/newbot" }));

    expect(
      await screen.findByRole("button", { name: "copied!" }),
    ).toBeInTheDocument();
    expect(copyAction).toHaveBeenCalledOnce();
  });

  it("only confirms the latest copy attempt", async () => {
    const first = deferredCopy();
    const second = deferredCopy();
    const copyAction = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<CopyButton copyAction={copyAction} showTooltip={false} />);
    const button = screen.getByRole("button", { name: "Copy to clipboard" });

    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {
      second.resolve(false);
      await second.promise;
    });
    await act(async () => {
      first.resolve(true);
      await first.promise;
    });

    expect(button).toHaveAccessibleName("Copy to clipboard");
  });

  it("removes a previous confirmation when the next copy fails", async () => {
    const copyAction = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("Clipboard permission denied"));
    render(<CopyButton copyAction={copyAction} showTooltip={false} />);
    const button = screen.getByRole("button", { name: "Copy to clipboard" });

    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toHaveAccessibleName("Copied");
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(button).toHaveAccessibleName("Copy to clipboard");
    });
  });

  it("shows feedback for the full duration after every successful copy", async () => {
    vi.useFakeTimers();
    const copyAction = vi.fn<() => Promise<boolean>>(() => {
      return Promise.resolve(true);
    });
    render(<CopyButton copyAction={copyAction} showTooltip={false} />);
    const button = screen.getByRole("button", { name: "Copy to clipboard" });

    await act(async () => {
      fireEvent.click(button);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await act(async () => {
      fireEvent.click(button);
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(button).toHaveAccessibleName("Copied");

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(button).toHaveAccessibleName("Copy to clipboard");
  });

  it("keeps confirmation state local to each button", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => {
      return Promise.resolve();
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(
      <>
        <CopyButton text="first" showTooltip={false} />
        <CopyButton text="second" showTooltip={false} />
      </>,
    );

    const [first, second] = screen.getAllByRole("button", {
      name: "Copy to clipboard",
    });
    if (!first || !second) {
      throw new Error("Expected two copy buttons");
    }
    expect(first).not.toHaveAttribute("data-base-ui-tooltip-trigger");
    expect(second).not.toHaveAttribute("data-base-ui-tooltip-trigger");

    fireEvent.click(first);
    await waitFor(() => {
      expect(first).toHaveAccessibleName("Copied");
      expect(second).toHaveAccessibleName("Copy to clipboard");
    });

    fireEvent.click(second);
    await waitFor(() => {
      expect(first).toHaveAccessibleName("Copied");
      expect(second).toHaveAccessibleName("Copied");
    });
    expect(writeText).toHaveBeenNthCalledWith(1, "first");
    expect(writeText).toHaveBeenNthCalledWith(2, "second");
  });

  it("clears its confirmation timer when unmounted", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(() => {
      return Promise.resolve();
    });
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const clearTimeout = vi.spyOn(globalThis, "clearTimeout");

    const { unmount } = render(
      <CopyButton text="first" resetDelay={60_000} showTooltip={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy to clipboard" }));
    await waitFor(() => {
      expect(screen.getByRole("button")).toHaveAccessibleName("Copied");
    });

    const callsBeforeUnmount = clearTimeout.mock.calls.length;
    unmount();

    expect(clearTimeout).toHaveBeenCalledTimes(callsBeforeUnmount + 1);
  });
});
