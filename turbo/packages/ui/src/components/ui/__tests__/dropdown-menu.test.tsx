import { createRef, useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "../dialog";
import { Button } from "../button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuCheckboxItemIndicator,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";

function TestMenu({
  keepOpen = false,
  onAction,
}: {
  keepOpen?: boolean;
  onAction?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" />}>
        Actions
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem closeOnClick={!keepOpen} onClick={onAction}>
          Rename
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("DropdownMenu", () => {
  it.each(["pointer", "Enter", "Space"])(
    "preserves native checkbox state, change details and focus for %s activation",
    async (activation) => {
      const user = userEvent.setup();
      const itemRef = createRef<HTMLElement>();
      const indicatorRef = createRef<HTMLSpanElement>();
      const onCheckedChange = vi.fn();

      function CheckboxMenu() {
        const [checked, setChecked] = useState(false);
        return (
          <DropdownMenu>
            <DropdownMenuTrigger>Types</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuCheckboxItem
                ref={itemRef}
                checked={checked}
                closeOnClick={false}
                className={(state) => {
                  return state.checked ? "font-semibold" : "font-normal";
                }}
                onCheckedChange={(nextChecked, details) => {
                  onCheckedChange(nextChecked, details);
                  setChecked(nextChecked);
                }}
              >
                <DropdownMenuCheckboxItemIndicator ref={indicatorRef}>
                  Selected
                </DropdownMenuCheckboxItemIndicator>
                HTTP
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      }

      render(<CheckboxMenu />);
      const trigger = screen.getByRole("button", { name: "Types" });
      await user.click(trigger);
      const item = await screen.findByRole("menuitemcheckbox", {
        name: "HTTP",
      });
      expect(itemRef.current).toBe(item);
      expect(item).toHaveAttribute("aria-checked", "false");
      expect(screen.queryByText("Selected")).not.toBeInTheDocument();

      if (activation === "pointer") {
        await user.click(item);
      } else {
        await user.keyboard("{ArrowDown}");
        expect(item).toHaveFocus();
        await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
      }

      expect(item).toHaveAttribute("aria-checked", "true");
      expect(item).toHaveClass("font-semibold");
      expect(indicatorRef.current).toBe(screen.getByText("Selected"));
      expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(
        true,
        expect.objectContaining({
          reason: "item-press",
          event: expect.any(Event),
          cancel: expect.any(Function),
        }),
      );
      expect(screen.getByRole("menu")).toBeInTheDocument();

      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
      });
    },
  );

  it("keeps the menu open when an item opts out of closing", async () => {
    render(<TestMenu keepOpen />);

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("forwards native item actions and closes the menu", async () => {
    const onAction = vi.fn();
    render(<TestMenu onAction={onAction} />);

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    expect(onAction).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("does not restore trigger focus after a pointer dismissal", async () => {
    render(<TestMenu />);

    const trigger = screen.getByRole("button", { name: "Actions" });
    fireEvent.click(trigger);
    await screen.findByRole("menu");
    const focus = vi.spyOn(trigger, "focus");

    fireEvent.pointerDown(document.body, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(focus).not.toHaveBeenCalled();
  });

  it("restores trigger focus after Escape", async () => {
    render(<TestMenu />);

    const trigger = screen.getByRole("button", { name: "Actions" });
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu");

    fireEvent.keyDown(menu, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it.each(["pointer", "Enter", "Space"])(
    "preserves one tooltip/menu/button trigger for %s activation and focus restoration",
    async (activation) => {
      const user = userEvent.setup();
      const tooltipRef = createRef<HTMLButtonElement>();
      const menuRef = createRef<HTMLButtonElement>();
      const buttonRef = createRef<HTMLElement>();
      const onClick = vi.fn();
      const { container } = render(
        <DropdownMenu>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                ref={tooltipRef}
                render={
                  <DropdownMenuTrigger
                    ref={menuRef}
                    render={
                      <Button
                        ref={buttonRef}
                        onClick={onClick}
                        aria-label="Download options"
                      >
                        Download
                      </Button>
                    }
                  />
                }
              />
              <TooltipContent>Download artifact</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <DropdownMenuContent>
            <DropdownMenuItem>Download</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>,
      );

      const trigger = screen.getByRole("button", { name: "Download options" });
      expect(container.querySelectorAll("button")).toHaveLength(1);
      expect(tooltipRef.current).toBe(trigger);
      expect(menuRef.current).toBe(trigger);
      expect(buttonRef.current).toBe(trigger);
      expect(trigger).toHaveAttribute("type", "button");
      expect(trigger).toHaveAttribute("aria-haspopup", "menu");
      await user.hover(trigger);
      expect(await screen.findByText("Download artifact")).toBeInTheDocument();
      if (activation === "pointer") {
        await user.click(trigger);
      } else {
        await user.tab();
        await user.keyboard(activation === "Enter" ? "{Enter}" : " ");
      }

      expect(
        await screen.findByRole("menuitem", { name: "Download" }),
      ).toBeInTheDocument();
      expect(onClick).toHaveBeenCalledOnce();
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      await waitFor(() => {
        expect(screen.queryByText("Download artifact")).not.toBeInTheDocument();
      });
      await user.keyboard("{Escape}");
      await waitFor(() => {
        expect(screen.queryByRole("menu")).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
      });
    },
  );

  it("opens a submenu when its trigger is clicked", async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Archive</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    const submenuTrigger = await screen.findByRole("menuitem", {
      name: "More",
    });
    fireEvent.pointerDown(submenuTrigger, { button: 0 });
    fireEvent.click(submenuTrigger);

    expect(
      await screen.findByRole("menuitem", { name: "Archive" }),
    ).toBeVisible();
  });

  it("nests menu and tooltip portals in their owning dialog", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Artifact preview</DialogTitle>
          <DropdownMenu open>
            <DropdownMenuTrigger>Download options</DropdownMenuTrigger>
            <DropdownMenuContent>
              <TooltipProvider>
                <Tooltip open>
                  <TooltipTrigger
                    render={<DropdownMenuItem>Download</DropdownMenuItem>}
                  />
                  <TooltipContent>Download artifact</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </DropdownMenuContent>
          </DropdownMenu>
        </DialogContent>
      </Dialog>,
    );

    const dialogPortal = screen
      .getByRole("dialog", { name: "Artifact preview" })
      .closest<HTMLElement>("[data-base-ui-portal]");
    const menuPortal = screen
      .getByRole("menu")
      .closest<HTMLElement>("[data-base-ui-portal]");
    const tooltipPortal = screen
      .getByText("Download artifact")
      .closest<HTMLElement>("[data-base-ui-portal]");

    expect(dialogPortal).toContainElement(menuPortal);
    expect(menuPortal).toContainElement(tooltipPortal);
  });
});
