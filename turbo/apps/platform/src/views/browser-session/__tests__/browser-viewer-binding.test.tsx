import { browserContract } from "@okouai/api-contracts/contracts/browser";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";

const context = testContext();

test("Wait for the fresh binding before reconnecting to the replacement window", async () => {
  const { cdp, viewer, openPage } = arrangeNativePage(
    context,
    {
      targets: [
        {
          targetId: "owned",
          title: "Replacement page",
          url: "https://replacement.example",
          windowId: 202,
        },
        {
          targetId: "sibling",
          title: "Sibling page",
          url: "https://sibling.example",
          windowId: 203,
        },
      ],
    },
    101,
  );
  cdp.failNext(
    "Target.setDiscoverTargets",
    "Initial native connection unavailable",
  );
  const bindingRequested = context.mocks.deferred<void>();
  const releaseBinding = context.mocks.deferred<void>();
  let reads = 0;
  let current = viewer;
  context.mocks.api(browserContract.get, async ({ query, respond }) => {
    expect(query?.viewer).toBe("native");
    reads += 1;
    if (reads === 2) {
      bindingRequested.resolve();
      await releaseBinding.promise;
      current = {
        ...viewer,
        browser: {
          ...viewer.browser,
          window: {
            instanceId: "a0000000-0000-4000-a000-000000000873",
            primaryWindowId: 202,
          },
        },
      };
    }
    return respond(200, { browser: current.browser, viewer: current });
  });
  context.mocks.api(browserContract.leaseByThread, ({ respond }) => {
    return respond(200, { browser: current.browser });
  });
  await openPage();
  const reconnect = await screen.findByText("Reconnect");
  const before = cdp.connections();

  click(reconnect);
  await bindingRequested.promise;
  expect(cdp.connections()).toBe(before);
  expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
  releaseBinding.resolve();

  await expectStreamingAt("https://replacement.example");
  expect(screen.queryByText("Sibling page")).not.toBeInTheDocument();
  const count = cdp.targets.length;
  click(screen.getByLabelText("New tab"));
  await waitFor(() => {
    expect(cdp.targets).toHaveLength(count + 1);
    expect(cdp.targets.at(-1)?.windowId).toBe(202);
  });
  expect(reads).toBe(2);
});

async function separateImageOption() {
  click(screen.getByLabelText("Browser settings"));
  click(await screen.findByText("Connection mode"));
  return await waitFor(() => {
    const option = queryAllByRoleFast("menuitemradio").find((candidate) => {
      return candidate.textContent?.trim() === "Separate image connection";
    });
    if (!option) {
      throw new Error("Separate image connection option is unavailable");
    }
    return option;
  });
}

test.each([{ phase: "socket opening" }, { phase: "native attachment" }])(
  "Switch to a separate image connection while $phase is pending",
  async ({ phase }) => {
    const { cdp, openPage } = arrangeNativePage(context, {
      autoOpen: phase !== "socket opening",
    });
    const attachment =
      phase === "native attachment"
        ? cdp.holdNext("Target.attachToTarget")
        : undefined;
    await openPage();
    if (attachment) {
      await attachment.received;
    } else {
      await waitFor(() => {
        expect(cdp.connections()).toBeGreaterThan(0);
      });
    }
    expect(screen.getByLabelText("Remote browser input")).toBeDisabled();
    click(await separateImageOption());
    if (attachment) {
      await attachment.release();
    } else {
      cdp.setAutoOpen(true);
      cdp.openConnection();
    }

    await expectStreamingAt("https://example.com");
    expect(cdp.targets).toHaveLength(1);
    expect(await separateImageOption()).toBeChecked();
  },
);
