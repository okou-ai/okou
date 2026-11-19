import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();
const mib = 1024 * 1024;

test("Render a 48 MiB first image on the shared connection", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  const firstFrame = cdp.holdFrames("target:example-page");
  await openPage();
  await firstFrame.received;
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();

  firstFrame.release("A".repeat(48 * mib));

  await expectStreamingAt("https://example.com");
});

test("Reconnect explicitly after an oversized transport message disconnects", async () => {
  const { cdp, openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt("https://example.com");

  cdp.event("Network.dataReceived", { payload: "A".repeat(49 * mib) });

  await expect(
    screen.findByText("Browser disconnected"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  click(await screen.findByText("Reconnect"));

  await expectStreamingAt("https://example.com");
});
