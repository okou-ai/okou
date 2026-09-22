import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../dialog";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "../popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../tooltip";

describe("Popover", () => {
  it.each(["Enter", "Space"])(
    "keeps an intentional non-button trigger's role, refs and %s activation",
    async (activation) => {
      const user = userEvent.setup();
      const triggerAction = vi.fn();
      const hostRef = { current: null as HTMLDivElement | null };
      render(
        <Popover>
          <PopoverTrigger
            nativeButton={false}
            render={
              <div
                ref={hostRef}
                role="combobox"
                aria-label="Choose sources"
                tabIndex={0}
                onClick={triggerAction}
              />
            }
          />
          <PopoverContent aria-label="Sources">
            <PopoverClose render={<Button>Done</Button>} />
          </PopoverContent>
        </Popover>,
      );

      const trigger = screen.getByRole("combobox", { name: "Choose sources" });
      expect(trigger).toBeInstanceOf(HTMLDivElement);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(hostRef.current).toBe(trigger);
      expect(screen.queryByRole("button")).toBeNull();
      await user.tab();
      expect(trigger).toHaveFocus();
      await user.keyboard(activation === "Enter" ? "{Enter}" : " ");

      expect(
        await screen.findByRole("dialog", { name: "Sources" }),
      ).toBeInTheDocument();
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(triggerAction).toHaveBeenCalledOnce();
      await user.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Sources" })).toBeNull();
        expect(trigger).toHaveFocus();
      });
    },
  );

  it.each(["tooltip", "popover"])(
    "shares one native trigger with an outer %s and restores nested focus in order",
    async (outer) => {
      const user = userEvent.setup();
      const triggerAction = vi.fn();
      const triggerRef = { current: null as HTMLElement | null };
      const button = (
        <Button
          ref={triggerRef}
          onClick={triggerAction}
          aria-label="Open sources"
        >
          Sources
        </Button>
      );
      render(
        <Dialog>
          <DialogTrigger render={<Button>Open settings</Button>} />
          <DialogContent closeLabel="Close settings">
            <DialogTitle>Settings</DialogTitle>
            <Popover>
              <TooltipProvider>
                <Tooltip>
                  {outer === "tooltip" ? (
                    <TooltipTrigger
                      render={<PopoverTrigger render={button} />}
                    />
                  ) : (
                    <PopoverTrigger
                      render={<TooltipTrigger render={button} />}
                    />
                  )}
                  <TooltipContent>Choose the connected sources</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <PopoverContent aria-label="Sources">
                <PopoverClose render={<Button>Done</Button>} />
              </PopoverContent>
            </Popover>
          </DialogContent>
        </Dialog>,
      );

      const settingsTrigger = screen.getByRole("button", {
        name: "Open settings",
      });
      await user.click(settingsTrigger);
      const sourceTrigger = screen.getByRole("button", {
        name: "Open sources",
      });
      expect(
        screen.getAllByRole("button", { name: "Open sources" }),
      ).toHaveLength(1);
      expect(sourceTrigger).toBeInstanceOf(HTMLButtonElement);
      expect(sourceTrigger.querySelector("button")).toBeNull();
      expect(triggerRef.current).toBe(sourceTrigger);
      await user.click(sourceTrigger);
      expect(
        await screen.findByRole("dialog", { name: "Sources" }),
      ).toBeInTheDocument();
      expect(triggerAction).toHaveBeenCalledOnce();
      await user.click(screen.getByRole("button", { name: "Done" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Sources" })).toBeNull();
        expect(sourceTrigger).toHaveFocus();
      });
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Close settings" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
        expect(settingsTrigger).toHaveFocus();
      });
    },
  );

  it("nests its portal under the owning dialog portal", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Artifact preview</DialogTitle>
          <Popover open>
            <PopoverTrigger>Open menu</PopoverTrigger>
            <PopoverContent>Menu content</PopoverContent>
          </Popover>
        </DialogContent>
      </Dialog>,
    );

    const dialogPortal = screen
      .getByRole("dialog", { name: "Artifact preview" })
      .closest<HTMLElement>("[data-base-ui-portal]");
    const popoverPortal = screen
      .getByText("Menu content")
      .closest<HTMLElement>("[data-base-ui-portal]");

    expect(dialogPortal).toBeInTheDocument();
    expect(popoverPortal).toBeInTheDocument();
    expect(dialogPortal).not.toBe(popoverPortal);
    expect(dialogPortal).toContainElement(popoverPortal);
  });
});
