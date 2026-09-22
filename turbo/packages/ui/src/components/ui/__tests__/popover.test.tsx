import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { describe, expect, it } from "vitest";

import { Dialog, DialogContent, DialogTitle } from "../dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";

function TriggerlessPopover({ insideDialog }: { insideDialog: boolean }) {
  const [open, setOpen] = useState(true);
  const anchor = useRef<HTMLButtonElement>(null);
  const content = (
    <>
      <button ref={anchor} type="button">
        Before suggestions
      </button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverContent anchor={anchor} initialFocus={false} finalFocus={false}>
          <button type="button">Suggestion</button>
        </PopoverContent>
      </Popover>
      <button type="button">After suggestions</button>
    </>
  );
  return insideDialog ? (
    <Dialog open>
      <DialogContent>
        <DialogTitle>Composer</DialogTitle>
        {content}
      </DialogContent>
    </Dialog>
  ) : (
    content
  );
}

describe("Popover", () => {
  it.each([false, true])(
    "tabs out of a triggerless popover (inside dialog: %s)",
    async (insideDialog) => {
      const user = userEvent.setup({ delay: null });
      render(<TriggerlessPopover insideDialog={insideDialog} />);
      if (insideDialog) {
        await waitFor(() => {
          expect(
            screen.getByRole("button", { name: "Before suggestions" }),
          ).toHaveFocus();
        });
      }
      await user.click(screen.getByRole("button", { name: "Suggestion" }));
      expect(screen.getByRole("button", { name: "Suggestion" })).toHaveFocus();

      await user.tab();

      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "After suggestions" }),
        ).toHaveFocus();
        expect(
          screen.queryByRole("button", { name: "Suggestion" }),
        ).not.toBeInTheDocument();
      });
    },
  );

  it.each([false, true])(
    "tabs backward from a triggerless popover (inside dialog: %s)",
    async (insideDialog) => {
      const user = userEvent.setup({ delay: null });
      render(<TriggerlessPopover insideDialog={insideDialog} />);
      if (insideDialog) {
        await waitFor(() => {
          expect(
            screen.getByRole("button", { name: "Before suggestions" }),
          ).toHaveFocus();
        });
      }
      await user.click(screen.getByRole("button", { name: "Suggestion" }));
      expect(screen.getByRole("button", { name: "Suggestion" })).toHaveFocus();

      await user.tab({ shift: true });

      expect(
        screen.getByRole("button", { name: "Before suggestions" }),
      ).toHaveFocus();
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
