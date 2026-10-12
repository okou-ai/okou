import { screen } from "@testing-library/react";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";

export async function clickComposerAddMenuItem(name: string): Promise<void> {
  click(await screen.findByLabelText("Add"));
  const menu = await screen.findByRole("menu", { name: "Add" });
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Expected the ${name} composer add menu item`);
  }
  click(item);
}
