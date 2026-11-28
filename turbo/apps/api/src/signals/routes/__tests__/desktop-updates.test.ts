import { desktopUpdatesContract } from "@okouai/api-contracts/contracts/desktop-updates";
import { expect, test } from "vitest";

import {
  accept,
  desktopCompatibility,
  testContext,
} from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { desktopUpdateRoutes } from "../desktop-updates";

const context = testContext();

test("desktop-updates-001 exposes the Desktop version floor without signing in and reflects disabling it", async () => {
  const updates = setupApp({ context, routes: desktopUpdateRoutes })(
    desktopUpdatesContract,
  );
  const readFloor = () => {
    return accept(updates.compatibility(), [200]);
  };

  desktopCompatibility.minimumSupportedVersion = "0.54.0";
  const committed = await readFloor();
  desktopCompatibility.minimumSupportedVersion = null;
  const disabled = await readFloor();
  desktopCompatibility.minimumSupportedVersion = "0.51.0";
  const lowered = await readFloor();
  desktopCompatibility.minimumSupportedVersion = null;
  const disabledAgain = await readFloor();

  expect(
    [committed, disabled, lowered, disabledAgain].map((response) => {
      return response.body.minimumSupportedVersion;
    }),
  ).toStrictEqual(["0.54.0", null, "0.51.0", null]);
  for (const response of [committed, disabled]) {
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
