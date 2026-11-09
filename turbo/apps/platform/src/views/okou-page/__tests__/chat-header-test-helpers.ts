import { screen } from "@testing-library/react";
import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { fastButton } from "./chat-list-test-helpers.ts";

export async function selectDesktopHeaderAction(
  name: string,
  container: ParentNode = document.body,
) {
  click(fastButton("More actions", container));
  const menu = await screen.findByRole("menu");
  const item = queryAllByRoleFast("menuitem", menu).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!item) {
    throw new Error(`Missing header menu item: ${name}`);
  }
  click(item);
}
