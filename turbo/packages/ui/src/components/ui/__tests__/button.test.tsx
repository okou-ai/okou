import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Button, buttonVariants } from "../button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button")).toHaveTextContent("Click me");
  });

  it("forwards ref", () => {
    const ref = { current: null as HTMLButtonElement | null };
    render(<Button ref={ref}>Ref test</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("merges custom className", () => {
    render(<Button className="custom-class">Custom</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("custom-class");
  });

  it("handles disabled state", () => {
    render(<Button disabled>Disabled</Button>);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
  });

  it("states the neutral fill with overlays so the fill survives", () => {
    // A translucent `bg-state-*` sets `background-color` and would replace
    // `bg-control-surface`, dropping the fill's warm cast on hover.
    render(<Button variant="neutral">Neutral</Button>);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("bg-control-surface");
    expect(button).toHaveClass("[&:hover]:bg-state-hover-overlay");
    expect(button).toHaveClass("[&:active]:bg-state-pressed-overlay");
    expect(button).not.toHaveClass("hover:bg-state-hover");
    expect(button).not.toHaveClass("active:bg-state-pressed");
  });

  it("shows the accessible label in a tooltip", async () => {
    const user = userEvent.setup();
    render(
      <Button
        showTooltip
        aria-label="Open settings"
        title="Legacy settings title"
      >
        Settings icon
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Open settings" });
    expect(button).not.toHaveAttribute("title");
    await user.hover(button);

    expect(await screen.findByText("Open settings")).toBeVisible();
  });

  it("shows the accessible label for a disabled button", async () => {
    const user = userEvent.setup();
    render(
      <Button showTooltip disabled aria-label="Send message">
        Send icon
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Send message" });
    expect(button).toBeDisabled();
    const trigger = button.closest<HTMLElement>(
      '[data-slot="tooltip-trigger"]',
    );
    if (trigger === null) {
      throw new Error("Disabled button tooltip trigger not found");
    }
    await user.hover(trigger);

    expect(await screen.findByText("Send message")).toBeVisible();
  });

  it("keeps dropdown trigger composition when showing a tooltip", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="neutral" showTooltip aria-label="More actions" />
          }
        >
          More icon
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    await user.click(screen.getByRole("button", { name: "More actions" }));

    expect(
      await screen.findByRole("menuitem", { name: "Rename" }),
    ).toBeVisible();
  });

  it("keeps popover trigger composition when showing a tooltip", async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger
          render={
            <Button showTooltip aria-label="Open details">
              Details icon
            </Button>
          }
        />
        <PopoverContent>Details panel</PopoverContent>
      </Popover>,
    );

    await user.click(screen.getByRole("button", { name: "Open details" }));

    expect(await screen.findByText("Details panel")).toBeVisible();
  });

  it("keeps a styled tooltip link's semantics, destination, ref, and keyboard focus", async () => {
    const user = userEvent.setup();
    const ref = { current: null as HTMLAnchorElement | null };
    const { container } = render(
      <Tooltip>
        <TooltipTrigger
          render={
            <a
              href="/settings"
              target="_blank"
              rel="noreferrer"
              ref={ref}
              className={buttonVariants({ variant: "neutral" })}
            >
              Settings
            </a>
          }
        />
        <TooltipContent role="tooltip">Manage preferences</TooltipContent>
      </Tooltip>,
    );

    const link = screen.getByRole("link", { name: "Settings" });
    expect(link).toHaveAttribute("href", "/settings");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(container.firstElementChild).toBe(link);
    expect(screen.queryByRole("button")).toBeNull();
    expect(ref.current).toBe(link);
    await user.tab();
    expect(link).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Manage preferences",
    );
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
    expect(link).toHaveFocus();
  });

  it.each([true, false])(
    "activates once per pointer or keyboard action and blocks loading actions (native: %s)",
    async (nativeButton) => {
      const user = userEvent.setup();
      function Action() {
        const [count, setCount] = useState(0);
        return (
          <>
            <Button
              nativeButton={nativeButton}
              render={nativeButton ? <button /> : <div />}
              disabled={count === 3}
              focusableWhenDisabled
              aria-label="Run action"
              aria-busy={count === 3}
              onClick={() => {
                setCount((previous) => {
                  return previous + 1;
                });
              }}
            >
              {count === 3 ? "Running" : "Run"}
            </Button>
            <output>{count}</output>
          </>
        );
      }
      render(<Action />);
      const button = screen.getByRole("button", { name: "Run action" });
      await user.click(button);
      expect(screen.getByRole("status")).toHaveTextContent("1");
      await user.keyboard("{Enter}");
      expect(screen.getByRole("status")).toHaveTextContent("2");
      await user.keyboard(" ");
      expect(screen.getByRole("status")).toHaveTextContent("3");
      expect(button).toHaveFocus();
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAttribute("aria-busy", "true");
      await user.click(button);
      await user.keyboard("{Enter} ");
      expect(screen.getByRole("status")).toHaveTextContent("3");
    },
  );

  it("opens a composed dialog and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger
          render={
            <Button type="button" variant="neutral">
              Add automation
            </Button>
          }
        />
        <DialogContent>
          <DialogTitle>Choose automation</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Add automation" });
    expect(trigger).toHaveAttribute("type", "button");
    await user.click(trigger);
    expect(
      screen.getByRole("dialog", { name: "Choose automation" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Choose automation" }),
      ).toBeNull();
      expect(trigger).toHaveFocus();
    });
  });
});
