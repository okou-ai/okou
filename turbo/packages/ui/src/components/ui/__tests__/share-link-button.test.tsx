import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShareLinkButton } from "../share-link-button";

function deferredShare() {
  let resolveShare: (shared: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolveShare = resolve;
  });
  return {
    promise,
    resolve: (shared: boolean) => {
      resolveShare(shared);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ShareLinkButton", () => {
  it("confirms the copied link in the click before sharing settles", () => {
    const share = deferredShare();
    render(
      <ShareLinkButton
        shareAction={() => {
          return share.promise;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(
      screen.getByRole("button", { name: "Share link copied" }),
    ).toHaveTextContent("Share link copied");
  });

  it("reverts when sharing fails", async () => {
    const share = deferredShare();
    render(
      <ShareLinkButton
        shareAction={() => {
          return share.promise;
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Share" });

    fireEvent.click(button);
    await act(async () => {
      share.resolve(false);
      await share.promise;
    });

    expect(button).toHaveAccessibleName("Share");
  });

  it("only lets the latest attempt revert the confirmation", async () => {
    const first = deferredShare();
    const second = deferredShare();
    const shareAction = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<ShareLinkButton shareAction={shareAction} />);
    const button = screen.getByRole("button", { name: "Share" });

    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => {
      first.resolve(false);
      await first.promise;
    });

    expect(button).toHaveAccessibleName("Share link copied");
  });

  it("resets after the delay", () => {
    vi.useFakeTimers();
    render(
      <ShareLinkButton
        resetDelay={1000}
        shareAction={() => {
          return Promise.resolve(true);
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Share" });

    fireEvent.click(button);
    expect(button).toHaveAccessibleName("Share link copied");
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(button).toHaveAccessibleName("Share");
  });

  it("exposes the copied state to a custom render", () => {
    render(
      <ShareLinkButton
        shareAction={() => {
          return Promise.resolve(true);
        }}
        render={({ onClick, ref }, { copied }) => {
          return (
            <button ref={ref} onClick={onClick}>
              {copied ? "custom copied" : "custom share"}
            </button>
          );
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "custom share" }));

    expect(
      screen.getByRole("button", { name: "custom copied" }),
    ).toBeInTheDocument();
  });
});
