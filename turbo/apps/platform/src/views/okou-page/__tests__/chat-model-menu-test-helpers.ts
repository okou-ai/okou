import { waitFor } from "@testing-library/react";
import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";

export function queryModelMenuOption(
  label: string | RegExp | ((name: string) => boolean),
  container: ParentNode = document,
): HTMLElement | null {
  return (
    queryAllByRoleFast("menuitemradio", container).find((option) => {
      const name =
        option.getAttribute("aria-label") ?? option.textContent?.trim() ?? "";
      if (typeof label === "function") {
        return label(name);
      }
      return typeof label === "string" ? name === label : label.test(name);
    }) ?? null
  );
}

export function modelMenuOption(
  label: string | RegExp | ((name: string) => boolean),
  container: ParentNode = document,
): HTMLElement {
  const option = queryModelMenuOption(label, container);
  if (!option) {
    throw new Error(`Expected model option ${label}`);
  }
  return option;
}

export async function findModelMenuOption(
  label: string | RegExp | ((name: string) => boolean),
  container: ParentNode = document,
): Promise<HTMLElement> {
  return await waitFor(() => {
    return modelMenuOption(label, container);
  });
}
