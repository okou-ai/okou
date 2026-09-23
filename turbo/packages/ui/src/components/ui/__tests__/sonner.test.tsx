import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster, toast } from "../sonner";

describe("Toaster", () => {
  afterEach(() => {
    toast.dismiss();
  });

  it("preserves caller surface, toast options, icons and per-toast button styles", async () => {
    render(
      <Toaster
        style={{ "--normal-bg": "rebeccapurple" } as React.CSSProperties}
        icons={{ warning: <span>Custom warning icon</span> }}
        toastOptions={{
          duration: Infinity,
          style: { background: "navy", color: "white" },
          actionButtonStyle: { color: "yellow" },
        }}
      />,
    );

    toast.warning("Caller colors", {
      action: { label: "Open", onClick: () => {} },
      actionButtonStyle: { color: "lime" },
    });

    const message = await screen.findByText("Caller colors");
    expect(message.closest("[data-sonner-toast]")).toHaveStyle({
      background: "navy",
      color: "white",
    });
    const toaster = message.closest<HTMLOListElement>("[data-sonner-toaster]");
    expect(toaster?.style.getPropertyValue("--normal-bg")).toBe(
      "rebeccapurple",
    );
    expect(screen.getByText("Custom warning icon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open" })).toHaveStyle({
      color: "lime",
    });
  });

  it("portals toast UI to body above app stacking contexts", async () => {
    const { container } = render(<Toaster />);

    toast.success("Saved");

    await screen.findByText("Saved");
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).toBeInTheDocument();
    expect(container.contains(toaster)).toBeFalsy();
    expect(toaster).toHaveStyle({ zIndex: "2147483647" });
  });

  it("keeps mobile toast placement aligned with the viewport safe area", async () => {
    render(<Toaster />);

    toast.success("Saved");

    await screen.findByText("Saved");
    const toaster = document.querySelector("[data-sonner-toaster]");
    expect(toaster).toBeInTheDocument();
    expect(toaster).toHaveStyle({ zIndex: "2147483647" });
    expect(
      (toaster as HTMLElement).style.getPropertyValue("--mobile-offset-top"),
    ).toBe("calc(var(--sat, env(safe-area-inset-top, 0px)) + 12px)");
    expect(
      (toaster as HTMLElement).style.getPropertyValue("--mobile-offset-left"),
    ).toBe("0px");
    expect(
      (toaster as HTMLElement).style.getPropertyValue("--mobile-offset-right"),
    ).toBe("0px");
    expect(
      (toaster as HTMLElement).style.getPropertyValue("--mobile-offset-bottom"),
    ).toBe("calc(var(--okou-safe-b, env(safe-area-inset-bottom, 0px)) + 16px)");
  });

  it("calls onReady only once when its callback identity changes", async () => {
    const firstOnReady = vi.fn<() => void>();
    const secondOnReady = vi.fn<() => void>();
    const { rerender } = render(<Toaster onReady={firstOnReady} />);

    await waitFor(() => {
      expect(firstOnReady).toHaveBeenCalledOnce();
    });
    rerender(<Toaster onReady={secondOnReady} />);

    await waitFor(() => {
      expect(secondOnReady).not.toHaveBeenCalled();
    });
  });
});
