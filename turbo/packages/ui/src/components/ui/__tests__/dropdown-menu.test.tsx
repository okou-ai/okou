import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "../dialog";
import {
  DropdownMenu,
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

  it("opens when its trigger is composed with a tooltip", async () => {
    render(
      <DropdownMenu>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  render={<button type="button">Download options</button>}
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

    fireEvent.click(screen.getByRole("button", { name: "Download options" }));

    expect(
      await screen.findByRole("menuitem", { name: "Download" }),
    ).toBeVisible();
  });

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
                  <TooltipTrigger asChild>
                    <DropdownMenuItem>Download</DropdownMenuItem>
                  </TooltipTrigger>
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
