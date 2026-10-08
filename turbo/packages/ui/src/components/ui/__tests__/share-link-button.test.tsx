import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ShareLinkButton } from "../share-link-button";

describe("ShareLinkButton", () => {
  it("confirms the copied link in the click before sharing settles", () => {
    render(<ShareLinkButton onShare={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    expect(
      screen.getByRole("button", { name: "Share link copied" }),
    ).toHaveTextContent("Share link copied");
  });

  it("reverts when sharing fails", () => {
    let revert: (() => void) | undefined;
    render(
      <ShareLinkButton
        onShare={(revertShare) => {
          revert = revertShare;
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Share" });

    fireEvent.click(button);
    expect(button).toHaveAccessibleName("Share link copied");
    act(() => {
      revert?.();
    });

    expect(button).toHaveAccessibleName("Share");
  });

  it("only lets the latest attempt revert the confirmation", () => {
    const reverts: (() => void)[] = [];
    render(
      <ShareLinkButton
        onShare={(revertShare) => {
          reverts.push(revertShare);
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "Share" });

    fireEvent.click(button);
    fireEvent.click(button);
    act(() => {
      reverts[0]?.();
    });

    expect(button).toHaveAccessibleName("Share link copied");
  });

  it("resets after the delay", async () => {
    render(<ShareLinkButton resetDelay={1} onShare={() => {}} />);
    const button = screen.getByRole("button", { name: "Share" });

    fireEvent.click(button);
    expect(button).toHaveAccessibleName("Share link copied");

    await waitFor(() => {
      expect(button).toHaveAccessibleName("Share");
    });
  });

  it("exposes the copied state to a custom render", () => {
    render(
      <ShareLinkButton
        onShare={() => {}}
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
