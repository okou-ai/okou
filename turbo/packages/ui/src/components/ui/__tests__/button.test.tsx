import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Button } from "../button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";

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
        <DropdownMenuTrigger asChild>
          <Button variant="neutral" showTooltip aria-label="More actions">
            More icon
          </Button>
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
        <PopoverTrigger asChild>
          <Button showTooltip aria-label="Open details">
            Details icon
          </Button>
        </PopoverTrigger>
        <PopoverContent>Details panel</PopoverContent>
      </Popover>,
    );

    await user.click(screen.getByRole("button", { name: "Open details" }));

    expect(await screen.findByText("Details panel")).toBeVisible();
  });

  it("preserves a composed link's element, destination, ref, and keyboard focus", async () => {
    const user = userEvent.setup();
    const ref = { current: null as HTMLAnchorElement | null };
    const { container } = render(
      <Button variant="neutral" asChild ref={ref}>
        <a href="/settings">Settings</a>
      </Button>,
    );

    const link = screen.getByRole("link", { name: "Settings" });
    expect(link).toHaveAttribute("href", "/settings");
    expect(container.firstElementChild).toBe(link);
    expect(screen.queryByRole("button")).toBeNull();
    expect(ref.current).toBe(link);
    await user.tab();
    expect(link).toHaveFocus();
  });

  it("opens a composed dialog and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button type="button" variant="neutral">
            Add automation
          </Button>
        </DialogTrigger>
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
