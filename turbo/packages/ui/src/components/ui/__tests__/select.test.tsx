import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../dialog";
import { Popover, PopoverContent, PopoverTrigger } from "../popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../select";

function ControlledSelect() {
  const [value, setValue] = useState("all");
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        setValue(nextValue);
      }}
    >
      <SelectTrigger variant="neutral" aria-label="Style: All">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All</SelectItem>
        <SelectItem value="professional">Professional</SelectItem>
      </SelectContent>
    </Select>
  );
}

describe("SelectItem", () => {
  it("does not report controlled value synchronization as user input", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const renderSelect = (value: string, includePeople = true) => {
      return (
        <Select value={value} onValueChange={onValueChange}>
          <SelectTrigger aria-label="Settings section">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {includePeople && <SelectItem value="people">People</SelectItem>}
            <SelectItem value="preference">Preference</SelectItem>
          </SelectContent>
        </Select>
      );
    };
    const view = render(renderSelect("preference"));
    await user.click(screen.getByLabelText("Settings section"));
    await screen.findByRole("option", { name: "People" });
    view.rerender(renderSelect("people"));
    onValueChange.mockClear();

    view.rerender(renderSelect("preference", false));

    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("renders items with non-empty values", () => {
    render(
      <Select defaultValue="a" open>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
          <SelectItem value="b">Beta</SelectItem>
        </SelectContent>
      </Select>,
    );
    const listbox = within(screen.getByRole("listbox"));
    expect(listbox.getByText("Alpha")).toBeInTheDocument();
    expect(listbox.getByText("Beta")).toBeInTheDocument();
  });

  it("opens inside a popover", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger>Open dialog</DialogTrigger>
        <DialogContent>
          <DialogTitle>Filters dialog</DialogTitle>
          <Popover>
            <PopoverTrigger>Filters</PopoverTrigger>
            <PopoverContent>
              <ControlledSelect />
            </PopoverContent>
          </Popover>
        </DialogContent>
      </Dialog>,
    );

    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    await user.click(screen.getByRole("button", { name: "Filters" }));
    await user.click(screen.getByLabelText("Style: All"));

    const professionalOption = await screen.findByRole("option", {
      name: "Professional",
    });
    const dialogPortal = screen
      .getByRole("dialog", { name: "Filters dialog" })
      .closest<HTMLElement>("[data-base-ui-portal]");
    const popoverPortal = screen
      .getByLabelText("Style: All")
      .closest<HTMLElement>("[data-base-ui-portal]");
    const selectPortal = professionalOption.closest<HTMLElement>(
      "[data-base-ui-portal]",
    );

    expect(dialogPortal).toContainElement(popoverPortal);
    expect(popoverPortal).toContainElement(selectPortal);

    await user.click(professionalOption);
    expect(screen.getByLabelText("Style: All")).toHaveTextContent(
      "Professional",
    );
  });
});
