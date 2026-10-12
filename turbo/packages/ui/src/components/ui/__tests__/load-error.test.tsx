import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LoadErrorRow, LoadErrorSection } from "../load-error";

describe("LoadErrorRow", () => {
  it("announces a failed read politely and re-reads on demand", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <LoadErrorRow
        message="Couldn't load SSH settings."
        retryLabel="Try again"
        onRetry={onRetry}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Couldn't load SSH settings.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("keeps the message and holds the button while the re-read runs", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <LoadErrorRow
        message="Couldn't load SSH settings."
        retryLabel="Try again"
        onRetry={onRetry}
        pending
      />,
    );

    const button = screen.getByRole("button", { name: "Try again" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Couldn't load SSH settings.",
    );
    await user.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });
});

describe("LoadErrorSection", () => {
  it("shares the empty state's footprint and offers a second way out", () => {
    render(
      <LoadErrorSection
        message="Still couldn't load artifacts."
        description="Check your connection, or reload the page."
        retryLabel="Try again"
        onRetry={vi.fn()}
        secondaryAction={<button type="button">Reload page</button>}
      />,
    );

    const status = screen.getByRole("status");
    expect(status).toHaveClass("rounded-xl", "border-dashed", "py-12");
    expect(status).toHaveTextContent(
      "Check your connection, or reload the page.",
    );
    expect(
      screen.getByRole("button", { name: "Reload page" }),
    ).toBeInTheDocument();
  });
});
