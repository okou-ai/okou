import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import entryStyles from "../index.css?inline";

const context = testContext();

test("safe-area-001 the default workspace follows changes to the physical bottom inset", async () => {
  const styles = document.createElement("style");
  styles.textContent = entryStyles;
  document.head.append(styles);
  const root = document.documentElement;
  try {
    await setupPage({ context, path: "/" });
    for (const inset of ["19px", "34px"]) {
      root.style.setProperty("--sab", inset);
      expect(
        getComputedStyle(root).getPropertyValue("--okou-safe-b").trim(),
      ).toBe(inset);
    }
  } finally {
    root.style.removeProperty("--sab");
    styles.remove();
  }
});
