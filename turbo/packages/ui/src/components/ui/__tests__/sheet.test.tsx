import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../dialog";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "../sheet";

describe("Sheet", () => {
  it("closes the nested sheet and returns focus to its parent dialog", async () => {
    const user = userEvent.setup();
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Connections</DialogTitle>
          <Sheet>
            <SheetTrigger>Open permissions</SheetTrigger>
            <SheetContent>
              <SheetTitle>Permissions</SheetTitle>
            </SheetContent>
          </Sheet>
        </DialogContent>
      </Dialog>,
    );

    const trigger = screen.getByRole("button", { name: "Open permissions" });
    await user.click(trigger);
    const sheet = screen.getByRole("dialog", { name: "Permissions" });
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Permissions" })).toBeNull();
      expect(trigger).toHaveFocus();
    });
    expect(screen.getByRole("dialog", { name: "Connections" })).toBeVisible();
  });

  it("closes through the icon control and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger>Open details</SheetTrigger>
        <SheetContent>
          <SheetTitle>Details</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    const trigger = screen.getByRole("button", { name: "Open details" });
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Details" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Details" })).toBeNull();
      expect(trigger).toHaveFocus();
    });
  });

  it("renders a visible overlay when nested in a dialog", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Parent dialog</DialogTitle>
          <Sheet open>
            <SheetContent>
              <SheetTitle>Nested sheet</SheetTitle>
            </SheetContent>
          </Sheet>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole("dialog", { name: "Nested sheet" })).toBeVisible();
    expect(document.querySelector('[data-slot="sheet-overlay"]')).toHaveClass(
      "bg-overlay/45",
      "transition-opacity",
      "data-ending-style:opacity-0",
    );
    expect(screen.getByRole("dialog", { name: "Nested sheet" })).toHaveClass(
      "transition-[translate,opacity]",
      "data-ending-style:translate-x-full",
      "data-ending-style:opacity-0",
    );
  });

  // The sheet is portalled and fixed, so the shell's padding never reaches it.
  // Before this, a right sheet's bottom row sat under the home indicator in a
  // standalone PWA. Only the edges it meets take an inset: the free edge sits
  // mid-screen, where an inset is a gap rather than a clearance.
  describe.each([
    { free: "pl", inset: ["pt", "pr", "pb"], side: "right" },
    { free: "pr", inset: ["pt", "pb", "pl"], side: "left" },
    { free: "pb", inset: ["pt", "pr", "pl"], side: "top" },
    { free: "pt", inset: ["pr", "pb", "pl"], side: "bottom" },
  ] as const)("a $side sheet", ({ free, inset, side }) => {
    function renderSheet() {
      render(
        <Sheet open>
          <SheetContent side={side}>
            <SheetTitle>Details</SheetTitle>
          </SheetContent>
        </Sheet>,
      );
      return screen.getByRole("dialog", { name: "Details" });
    }

    it("clears the insets on the edges it meets", () => {
      expect(renderSheet()).toHaveClass(
        ...inset.map((edge) => {
          return `${edge}-safe-offset-6`;
        }),
      );
    });

    it(`keeps a plain gutter on the ${free} edge`, () => {
      const sheet = renderSheet();

      expect(sheet).toHaveClass("p-6");
      expect(sheet.className).not.toContain(`${free}-safe`);
    });

    // Offsets on an absolutely positioned child resolve against the padding
    // box, so the popup's own insets leave this control where it was.
    it("clears the same edges for the close control", () => {
      renderSheet();
      const close = screen.getByRole("button", { name: "Close" });

      expect(close).toHaveClass(
        side === "bottom" ? "top-4" : "top-safe-offset-4",
        side === "left" ? "right-4" : "right-safe-offset-4",
      );
    });
  });
});
