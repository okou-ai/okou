import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "../dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select";
import { Sheet, SheetContent, SheetTitle } from "../sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";

// These portal to body level, where the app root cannot contain them, so their
// shared `z-50` is what ranks them against anything else that reaches body
// level. A primitive that stops carrying it stops being a peer of the others.
// Assert the layer that is actually portalled rather than the popup inside it:
// the popup is `relative` within its own layer, so its class would not stack.
function portalledLayerAround(inner: HTMLElement): HTMLElement {
  const layer = inner.closest<HTMLElement>(".z-50");
  expect(layer).toBeInTheDocument();
  expect(inner.closest("[data-base-ui-portal]")).toContainElement(layer);
  return layer as HTMLElement;
}

describe("floating layer stacking", () => {
  it("ranks the dialog backdrop and viewport at the shared floating level", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "z-50",
    );
    expect(document.querySelector('[data-slot="dialog-viewport"]')).toHaveClass(
      "z-50",
    );
  });

  it("ranks the sheet backdrop and popup at the shared floating level", () => {
    render(
      <Sheet open>
        <SheetContent>
          <SheetTitle>Queue</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(document.querySelector('[data-slot="sheet-overlay"]')).toHaveClass(
      "z-50",
    );
    expect(document.querySelector('[data-slot="sheet-content"]')).toHaveClass(
      "z-50",
    );
  });

  it("ranks the popover at the shared floating level", () => {
    render(
      <Popover open>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent>Popover body</PopoverContent>
      </Popover>,
    );

    portalledLayerAround(screen.getByText("Popover body"));
  });

  it("ranks the dropdown menu at the shared floating level", () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    portalledLayerAround(screen.getByText("Rename"));
  });

  it("ranks the select at the shared floating level", () => {
    render(
      <Select open value="fast">
        <SelectTrigger aria-label="Speed">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="fast">Fast</SelectItem>
        </SelectContent>
      </Select>,
    );

    // The trigger renders the same label, so ask for the listbox entry.
    portalledLayerAround(screen.getByRole("option", { name: "Fast" }));
  });

  it("ranks the tooltip at the shared floating level", () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Hover me</TooltipTrigger>
          <TooltipContent>Tooltip body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );

    portalledLayerAround(screen.getByText("Tooltip body"));
  });
});
