import { workflowsCollectionContract } from "@okouai/api-contracts/contracts/workflows";
import { waitFor } from "@testing-library/react";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export function workflowOptions(
  context: TestContext,
  names: string[],
  descriptions: Record<string, string> = {},
) {
  const entries = names.map((name) => {
    return {
      id: crypto.randomUUID(),
      name,
      displayName: null,
      description: descriptions[name] ?? null,
    };
  });
  context.mocks.api(workflowsCollectionContract.composer, ({ respond }) => {
    return respond(200, entries);
  });
  return entries;
}

export function slashRows() {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot="slash-workflow-name"]'),
  );
}

export function slashChoice(name: string) {
  return waitFor(() => {
    const choice = slashRows()
      .find((row) => {
        return row.textContent === "/" + name;
      })
      ?.closest("button");
    if (!choice) {
      throw new Error(
        "Missing workflow " +
          name +
          " among " +
          slashRows().map((r) => {
            return r.textContent;
          }),
      );
    }
    return choice;
  });
}
