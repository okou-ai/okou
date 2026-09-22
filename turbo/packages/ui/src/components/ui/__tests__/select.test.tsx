import { describe, it, expect } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
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
  const [value, setValue] = useState<string | null>("all");
  return (
    <Select
      items={[
        { value: "all", label: "All" },
        { value: "professional", label: "Professional" },
      ]}
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
  it("renders explicit labels before custom option components mount and follows dynamic values", async () => {
    const user = userEvent.setup();
    function Options({ includePeople }: { includePeople: boolean }) {
      return (
        <SelectContent>
          {includePeople && <SelectItem value="people">People</SelectItem>}
          <SelectItem value="preference">Preference</SelectItem>
        </SelectContent>
      );
    }
    const renderSelect = (value: string, includePeople = true) => {
      return (
        <Select
          value={value}
          items={[
            ...(includePeople ? [{ value: "people", label: "People" }] : []),
            { value: "preference", label: "Preference" },
          ]}
        >
          <SelectTrigger aria-label="Settings section">
            <SelectValue />
          </SelectTrigger>
          <Options includePeople={includePeople} />
        </Select>
      );
    };
    const view = render(renderSelect("people"));
    expect(screen.getByLabelText("Settings section")).toHaveTextContent(
      "People",
    );
    await user.click(screen.getByLabelText("Settings section"));
    await screen.findByRole("option", { name: "People" });

    view.rerender(renderSelect("preference", false));
    expect(screen.getByLabelText("Settings section")).toHaveTextContent(
      "Preference",
    );
    expect(
      screen.queryByRole("option", { name: "People" }),
    ).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "lets the caller accept or cancel nullable selection (cancel=%s)",
    async (cancelNull) => {
      const user = userEvent.setup();
      render(
        <form aria-label="Selection">
          <Select
            name="choice"
            defaultValue="a"
            items={[
              { value: "a", label: "Alpha" },
              { value: null, label: "Clear" },
            ]}
            onValueChange={(value, details) => {
              if (value === null && cancelNull) {
                details.cancel();
              }
            }}
          >
            <SelectTrigger aria-label="Choice">
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="a">Alpha</SelectItem>
              <SelectItem value={null}>Clear</SelectItem>
            </SelectContent>
          </Select>
        </form>,
      );
      await user.click(screen.getByLabelText("Choice"));
      await user.click(await screen.findByRole("option", { name: "Clear" }));
      const form = screen.getByRole<HTMLFormElement>("form", {
        name: "Selection",
      });
      expect(new FormData(form).get("choice")).toBe(cancelNull ? "a" : "");
      expect(screen.getByLabelText("Choice")).toHaveTextContent(
        cancelNull ? "Alpha" : "Clear",
      );
    },
  );

  it("submits the selected value after closed-trigger typeahead", async () => {
    const user = userEvent.setup();
    render(
      <form aria-label="Interval">
        <Select
          name="interval"
          defaultValue="60"
          items={{ "60": "Every minute", "3600": "Hourly" }}
        >
          <SelectTrigger aria-label="Repeat">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="60">Every minute</SelectItem>
            <SelectItem value="3600">Hourly</SelectItem>
          </SelectContent>
        </Select>
      </form>,
    );
    expect(screen.getByLabelText("Repeat")).toHaveTextContent("Every minute");
    await user.tab();
    await user.keyboard("h");
    await waitFor(() => {
      expect(screen.getByLabelText("Repeat")).toHaveTextContent("Hourly");
    });
    expect(screen.getByLabelText("Repeat")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      new FormData(
        screen.getByRole<HTMLFormElement>("form", { name: "Interval" }),
      ).get("interval"),
    ).toBe("3600");
  });

  it("preserves object equality and multi-select form serialization", async () => {
    const user = userEvent.setup();
    const items = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ];
    render(
      <form aria-label="Objects">
        <Select<{ id: string; name: string }, true>
          multiple
          name="objects"
          defaultValue={[{ id: "a", name: "Alpha" }]}
          isItemEqualToValue={(item, value) => {
            return item.id === value.id;
          }}
          itemToStringLabel={(item) => {
            return item.name;
          }}
          itemToStringValue={(item) => {
            return item.id;
          }}
        >
          <SelectTrigger aria-label="Objects">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => {
              return (
                <SelectItem key={item.id} value={item}>
                  {item.name}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      </form>,
    );
    expect(screen.getByRole("combobox", { name: "Objects" })).toHaveTextContent(
      "Alpha",
    );
    await user.click(screen.getByRole("combobox", { name: "Objects" }));
    expect(
      await screen.findByRole("option", { name: "Alpha" }),
    ).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("option", { name: "Beta" }));
    expect(
      new FormData(
        screen.getByRole<HTMLFormElement>("form", { name: "Objects" }),
      ).getAll("objects"),
    ).toEqual(["a", "b"]);
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

describe("Select option descriptions", () => {
  it("reads visible explanations without selecting and keeps selected text concise", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <>
        <p id="usage-pricing">Prices vary with usage</p>
        <Select defaultValue="alpha" onValueChange={onValueChange}>
          <SelectTrigger aria-label="Model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="alpha" label="Alpha" description="Economy model">
              Alpha
            </SelectItem>
            <SelectItem
              value="beta"
              label="Beta"
              description="Premium model"
              aria-describedby="usage-pricing"
            >
              Beta
            </SelectItem>
          </SelectContent>
        </Select>
      </>,
    );
    const trigger = screen.getByLabelText("Model");
    await user.click(trigger);
    const beta = await screen.findByRole("option", { name: "Beta" });
    expect(beta).toHaveAccessibleDescription(
      "Prices vary with usage Premium model",
    );
    expect(within(beta).getByText("Premium model")).toBeVisible();
    expect(onValueChange).not.toHaveBeenCalled();
    await user.click(beta);
    expect(onValueChange).toHaveBeenCalledOnce();
    expect(trigger).toHaveTextContent(/^Beta$/u);
  });
});
