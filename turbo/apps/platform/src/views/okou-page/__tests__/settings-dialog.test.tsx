import { test, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { findAction } from "./connector-integrations-test-helpers.ts";
const context = testContext();
test("settings-dialog-005 a workspace administrator switches from General to People inside Settings", async () => {
  context.mocks.data.org({ role: "admin" });
  await setupPage({ context, path: "/?settings=general" });
  const settings = await screen.findByRole("dialog");
  await within(settings).findByRole("heading", { name: "General" });
  click(await findAction("button", "People", settings));
  await waitFor(() => {
    return expect(
      within(settings).getByRole("heading", { name: "People" }),
    ).toBeVisible();
  });
  expect(settings).toBeVisible();
  expect(new URL(location.href).searchParams.get("settings")).toBe("people");
});
