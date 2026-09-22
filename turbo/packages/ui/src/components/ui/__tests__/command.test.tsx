import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import tailwindcss from "@tailwindcss/postcss";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postcss from "postcss";
import { useState } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Command,
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
} from "../command";
import { DialogDescription, DialogTitle } from "../dialog";

function BasicCommand() {
  const [selected, setSelected] = useState<string[]>([]);
  const select = (value: string) => {
    setSelected((previous) => {return [...previous, value]});
  };
  const [query, setQuery] = useState("");
  return (
    <Command
      mode="none"
      autoHighlight
      loopFocus
      value={query}
      onValueChange={(value, eventDetails) => {
        if (eventDetails.reason === "item-press") {
          eventDetails.cancel();
          return;
        }
        setQuery(value);
      }}
    >
      <CommandInput aria-label="Search" />
      <CommandList>
        <CommandItem value="alpha" onClick={() => {return select("alpha")}}>
          Alpha
        </CommandItem>
        <CommandItem value="bravo" onClick={() => {return select("bravo")}}>
          Bravo
        </CommandItem>
        <CommandItem value="charlie" onClick={() => {return select("charlie")}}>
          Charlie
        </CommandItem>
      </CommandList>
      <output aria-label="Selected commands">{selected.join(", ")}</output>
    </Command>
  );
}

describe("Command", () => {
  const style = document.createElement("style");
  const packageRoot = existsSync(resolve(process.cwd(), "src/styles"))
    ? process.cwd()
    : resolve(process.cwd(), "packages/ui");
  const globalStylesPath = resolve(packageRoot, "src/styles/globals.css");

  beforeAll(async () => {
    const globalStyles = await readFile(globalStylesPath, "utf8");
    const compiledStyles = await postcss([
      tailwindcss({ base: packageRoot }),
    ]).process(globalStyles, { from: globalStylesPath });
    const radiusRules: string[] = [];
    compiledStyles.root.walkRules((rule) => {
      const declarations: string[] = [];
      rule.walkDecls((declaration) => {
        if (
          declaration.parent === rule &&
          (declaration.prop === "border-radius" ||
            declaration.prop.startsWith("--radius"))
        ) {
          declarations.push(declaration.toString());
        }
      });
      if (declarations.length > 0) {
        radiusRules.push(`${rule.selector} { ${declarations.join("; ")} }`);
      }
    });
    style.textContent = radiusRules.join("\n");
    document.head.append(style);
  });

  afterAll(() => {
    style.remove();
  });

  it("keeps the caret outside a rounded input clipping boundary", () => {
    render(<BasicCommand />);
    const input = screen.getByRole("combobox", { name: "Search" });
    const wrapper = input.closest<HTMLElement>(
      '[data-slot="command-input-wrapper"]',
    );

    if (wrapper === null) {
      throw new Error("Command input wrapper was not rendered");
    }
    expect(getComputedStyle(input).borderRadius).toBe("0px");
    expect(getComputedStyle(wrapper).borderRadius).not.toBe("0px");
  });

  it("selects with Enter and navigates up, down, and around the item loop", async () => {
    const user = userEvent.setup({ delay: null });
    render(<BasicCommand />);
    const input = screen.getByRole("combobox", { name: "Search" });
    const alpha = screen.getByRole("option", { name: "Alpha" });
    const bravo = screen.getByRole("option", { name: "Bravo" });
    const charlie = screen.getByRole("option", { name: "Charlie" });

    await user.click(input);
    await user.keyboard("{ArrowDown}");
    expect(alpha).toHaveAttribute("data-highlighted");

    await user.keyboard("{ArrowDown}");
    expect(bravo).toHaveAttribute("data-highlighted");

    await user.keyboard("{ArrowUp}");
    expect(alpha).toHaveAttribute("data-highlighted");

    await user.keyboard("{ArrowUp}");
    expect(charlie).toHaveAttribute("data-highlighted");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(alpha).toHaveAttribute("data-highlighted");
    expect(screen.getByLabelText("Selected commands")).toHaveTextContent(
      /^alpha$/,
    );
  });

  it("uses dynamically rendered business-filtered results for keyboard selection", async () => {
    const user = userEvent.setup({ delay: null });
    function DynamicCommand() {
      const [selected, setSelected] = useState<string[]>([]);
      const [query, setQuery] = useState("");
      const items = ["Alpha", "Bravo", "Charlie"].filter((item) => {
        return item.toLowerCase().includes(query.toLowerCase());
      });
      return (
        <Command
          mode="none"
          autoHighlight
          loopFocus
          value={query}
          onValueChange={(value, eventDetails) => {
            if (eventDetails.reason === "item-press") {
              eventDetails.cancel();
              return;
            }
            setQuery(value);
          }}
        >
          <CommandInput aria-label="Dynamic search" />
          <CommandList>
            {items.map((item) => {
              const value = item.toLowerCase();
              return (
                <CommandItem
                  key={value}
                  value={value}
                  onClick={() => {
                    setSelected((previous) => {return [...previous, value]});
                  }}
                >
                  {item}
                </CommandItem>
              );
            })}
          </CommandList>
          <output aria-label="Selected commands">{selected.join(", ")}</output>
        </Command>
      );
    }

    render(<DynamicCommand />);
    const input = screen.getByRole("combobox", { name: "Dynamic search" });
    await user.click(input);
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "Alpha" })).toHaveAttribute(
      "data-highlighted",
    );

    await user.type(input, "br");
    expect(screen.queryByRole("option", { name: "Alpha" })).toBeNull();
    expect(screen.getByRole("option", { name: "Bravo" })).toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByLabelText("Selected commands")).toHaveTextContent(
      /^bravo$/,
    );
    expect(input).toHaveValue("br");
  });

  it("lets Escape close its parent command dialog", async () => {
    const user = userEvent.setup({ delay: null });

    function DialogCommand() {
      const [open, setOpen] = useState(true);
      const [query, setQuery] = useState("");
      return (
        <CommandDialog
          open={open}
          onOpenChange={setOpen}
          commandProps={{
            mode: "none",
            value: query,
            onValueChange: setQuery,
          }}
        >
          <DialogTitle>Choose a target</DialogTitle>
          <DialogDescription>Select one target</DialogDescription>
          <CommandInput aria-label="Dialog search" />
          <CommandList>
            <CommandItem value="alpha">Alpha</CommandItem>
          </CommandList>
        </CommandDialog>
      );
    }

    render(<DialogCommand />);
    const input = screen.getByRole("combobox", { name: "Dialog search" });
    await user.click(input);
    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("dialog", { name: "Choose a target" }),
    ).toBeNull();
  });

  it("activates a command once with a pointer click", async () => {
    const user = userEvent.setup({ delay: null });
    render(<BasicCommand />);

    await user.click(screen.getByRole("option", { name: "Bravo" }));

    expect(screen.getByLabelText("Selected commands")).toHaveTextContent(
      /^bravo$/,
    );
  });
});
