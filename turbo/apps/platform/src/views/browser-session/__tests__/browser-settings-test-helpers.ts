import { screen, within } from "@testing-library/react";
import { click } from "../../../__tests__/page-helper.ts";

export async function openQualityMenu() {
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Image quality"));
  return screen.findByRole("menu", { name: "Image quality" });
}

export async function openCustomQuality() {
  const menu = await openQualityMenu();
  click(within(menu).getByText("Custom"));
  return within(menu).getByRole("textbox", { name: "Image quality" });
}
