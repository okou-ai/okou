import { RuleTester } from "@typescript-eslint/rule-tester";
import { describe, it, afterAll } from "vitest";
import rule from "../rules/menu-row-height.ts";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("menu-row-height", rule, {
  valid: [
    // The shared row height, left to the component.
    {
      code: `<DropdownMenuItem onClick={onSelect}>{label}</DropdownMenuItem>`,
    },
    // Horizontal rhythm stays a caller decision.
    {
      code: `<DropdownMenuItem className="min-w-0 gap-3 px-3">{label}</DropdownMenuItem>`,
    },
    // `min-h-*` raises the floor for a touch target without forking the height.
    {
      code: `<DropdownMenuItem className="min-h-11">{label}</DropdownMenuItem>`,
    },
    // A hyphenated `h` inside another utility is not a height.
    {
      code: `<SelectItem className="overflow-hidden text-muted-foreground">{label}</SelectItem>`,
    },
    // Children keep their own sizing; only the row's own className is read.
    {
      code: `
        const row = (
          <DropdownMenuItem>
            <img src={icon} alt="" className="h-4 w-4 shrink-0" />
            {label}
          </DropdownMenuItem>
        );
      `,
    },
    // Other components are out of scope even with the same utility.
    {
      code: `<Button className="h-9 px-2">{label}</Button>`,
    },
  ],
  invalid: [
    {
      code: `<DropdownMenuItem className="gap-3 px-3 py-2.5">{label}</DropdownMenuItem>`,
      errors: [{ messageId: "menuRowHeight" }],
    },
    {
      code: `<DropdownMenuSubTrigger className="gap-3 px-3 py-2.5">{label}</DropdownMenuSubTrigger>`,
      errors: [{ messageId: "menuRowHeight" }],
    },
    {
      code: `<SelectItem className="h-8 pl-2 pr-8">{label}</SelectItem>`,
      errors: [{ messageId: "menuRowHeight" }],
    },
    // The app's own wrapper forwards className straight through.
    {
      code: `<DropdownMenuModalItem className="py-3" onModalSelect={open}>{label}</DropdownMenuModalItem>`,
      errors: [{ messageId: "menuRowHeight" }],
    },
    // A variant prefix still sets the height on some viewport or state.
    {
      code: `<DropdownMenuItem className="sm:py-3">{label}</DropdownMenuItem>`,
      errors: [{ messageId: "menuRowHeight" }],
    },
    // `cn(...)` hides the utility behind a call; the rule reads the source text.
    {
      code: `<DropdownMenuItem className={cn("px-3", compact && "h-8")}>{label}</DropdownMenuItem>`,
      errors: [{ messageId: "menuRowHeight" }],
    },
  ],
});
