import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { arrangeNativePage } from "./browser-native-page-fixture.ts";

const context = testContext();
test("browser-frame-budgets-01.01 displays the boundary-sized first image on the shared connection", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  const image = cdp.holdTargetFrames("example-page");
  await openPage();
  await image.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  expect(screen.queryByRole("img", { name: "Live browser view" })).toBeNull();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
  image.release("A".repeat(48 * 1024 * 1024));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
  expect(screen.getByRole("img", { name: "Live browser view" })).toBeVisible();
  expect(screen.getByLabelText("Address")).toHaveValue("https://example.com");
});
test("browser-frame-budgets-03 recovers usable input after a transport message exceeds its envelope", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  const input = await screen.findByLabelText("Remote browser input");
  await waitFor(() => {
    expect(input).toBeEnabled();
  });
  cdp.event("Runtime.consoleAPICalled", {
    payload: "x".repeat(49 * 1024 * 1024),
  });
  await screen.findByText("Browser disconnected");
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(await screen.findByText("Reconnect", { selector: "button" }));
  await waitFor(() => {
    expect(screen.getByLabelText("Remote browser input")).toBeEnabled();
  });
});
