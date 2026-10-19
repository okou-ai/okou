import { createRef, type RefObject } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, onTestFinished, test, vi } from "vitest";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import { Select, SelectContent, SelectItem, SelectTrigger } from "../select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";

async function expectPopup(ref: RefObject<HTMLDivElement | null>) {
  const popup = await screen.findByTestId("surface");
  await waitFor(() => {
    expect(popup).toBeVisible();
  });
  expect(ref.current).toBe(popup);
  expect(popup).toHaveAttribute("data-contract", "forwarded");
  expect(popup).toHaveClass("min-w-40");
  return popup;
}

async function expectCollapsedTrigger() {
  await waitFor(() => {
    expect(screen.getByLabelText("Show popup")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
}

async function exerciseSurface(
  ref: RefObject<HTMLDivElement | null>,
  user: ReturnType<typeof userEvent.setup>,
  content: string,
  open: () => Promise<void>,
  expectClosed = expectCollapsedTrigger,
) {
  const trigger = screen.getByLabelText("Show popup");
  expect(ref.current).toBeNull();
  expect(screen.queryByTestId("surface")).not.toBeInTheDocument();

  await open();
  const popup = await expectPopup(ref);
  expect(within(popup).getByText(content)).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await expectClosed();
  expect(trigger).toHaveFocus();

  await open();
  const reopened = await expectPopup(ref);
  expect(within(reopened).getByText(content)).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await expectClosed();
  expect(trigger).toHaveFocus();
}

test("menu preserves popup refs and props across escape and reopening", async () => {
  const ref = createRef<HTMLDivElement>();
  const user = userEvent.setup();
  const view = render(
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Show popup">Menu</DropdownMenuTrigger>
      <DropdownMenuContent
        ref={ref}
        className="min-w-40"
        data-contract="forwarded"
        data-testid="surface"
      >
        <DropdownMenuItem>Available</DropdownMenuItem>
        <DropdownMenuItem disabled>Unavailable</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  await exerciseSurface(ref, user, "Available", async () => {
    await user.click(screen.getByLabelText("Show popup"));
    const unavailable = await screen.findByText("Unavailable");
    expect(unavailable.closest('[role="menuitem"]')).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  view.unmount();
  expect(ref.current).toBeNull();
});

test("popover preserves popup refs and props across escape and reopening", async () => {
  const ref = createRef<HTMLDivElement>();
  const user = userEvent.setup();
  const view = render(
    <Popover>
      <PopoverTrigger aria-label="Show popup">Popover</PopoverTrigger>
      <PopoverContent
        ref={ref}
        className="min-w-40"
        data-contract="forwarded"
        data-testid="surface"
      >
        <button type="button">Popover action</button>
      </PopoverContent>
    </Popover>,
  );
  await exerciseSurface(ref, user, "Popover action", async () => {
    await user.click(screen.getByLabelText("Show popup"));
  });
  view.unmount();
  expect(ref.current).toBeNull();
});

test("select preserves popup refs and props across escape and reopening", async () => {
  const ref = createRef<HTMLDivElement>();
  const user = userEvent.setup();
  const view = render(
    <Select defaultValue="available">
      <SelectTrigger aria-label="Show popup">Select</SelectTrigger>
      <SelectContent
        ref={ref}
        className="min-w-40"
        data-contract="forwarded"
        data-testid="surface"
      >
        <SelectItem value="available">Available</SelectItem>
        <SelectItem value="unavailable" disabled>
          Unavailable
        </SelectItem>
      </SelectContent>
    </Select>,
  );
  await exerciseSurface(ref, user, "Available", async () => {
    await user.click(screen.getByLabelText("Show popup"));
    const unavailable = await screen.findByText("Unavailable");
    expect(unavailable.closest('[role="option"]')).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
  view.unmount();
  expect(ref.current).toBeNull();
});

test("tooltip preserves popup refs and props across escape and reopening", async () => {
  const ref = createRef<HTMLDivElement>();
  const user = userEvent.setup();
  const view = render(
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger aria-label="Show popup">Tooltip</TooltipTrigger>
        <TooltipContent
          ref={ref}
          className="min-w-40"
          data-contract="forwarded"
          data-testid="surface"
        >
          Helpful information
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
  await exerciseSurface(
    ref,
    user,
    "Helpful information",
    async () => {
      if (document.activeElement === screen.getByLabelText("Show popup")) {
        await user.tab();
      }
      await user.tab();
    },
    async () => {
      await waitFor(() => {
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
      });
    },
  );
  view.unmount();
  expect(ref.current).toBeNull();
});

test("menu reads changed safe-area insets when reopened", async () => {
  const root = document.documentElement;
  const previousInset = root.style.getPropertyValue("--okou-safe-b");
  const previousPriority = root.style.getPropertyPriority("--okou-safe-b");
  onTestFinished(() => {
    if (previousInset) {
      root.style.setProperty("--okou-safe-b", previousInset, previousPriority);
    } else {
      root.style.removeProperty("--okou-safe-b");
    }
  });
  root.style.setProperty("--okou-safe-b", "0px");
  const width = vi.spyOn(root, "clientWidth", "get").mockReturnValue(1024);
  onTestFinished(() => {
    width.mockRestore();
  });
  const height = vi.spyOn(root, "clientHeight", "get").mockReturnValue(768);
  onTestFinished(() => {
    height.mockRestore();
  });

  const user = userEvent.setup();
  render(
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Show popup">Menu</DropdownMenuTrigger>
      <DropdownMenuContent data-testid="geometry-surface">
        <DropdownMenuItem>Available</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  const trigger = screen.getByLabelText("Show popup");
  const anchor = vi
    .spyOn(trigger, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(100, 100, 120, 32));
  onTestFinished(() => {
    anchor.mockRestore();
  });
  const availableHeight = async () => {
    const popup = await screen.findByTestId("geometry-surface");
    const positioner = popup.parentElement;
    if (!positioner) {
      throw new Error("Expected the popup's positioned container");
    }
    return await waitFor(() => {
      const value = Number.parseFloat(
        window
          .getComputedStyle(positioner)
          .getPropertyValue("--available-height"),
      );
      expect(value).toBeGreaterThan(0);
      return value;
    });
  };

  await user.click(trigger);
  const initialHeight = await availableHeight();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryByTestId("geometry-surface")).not.toBeInTheDocument();
  });
  root.style.setProperty("--okou-safe-b", "96px");

  await user.click(trigger);
  const reopenedHeight = await availableHeight();
  expect(reopenedHeight).toBeCloseTo(initialHeight - 96);
});
