import { act, screen, waitFor } from "@testing-library/react";
import { morningBriefDebugTriggerContract } from "@okouai/api-contracts/contracts/morning-brief-debug-trigger";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect, test } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const DEBUG_PATH = "/?settings=debug";
const TRIGGER = "Run Morning Brief now";
const QUEUED = "Queued. The scheduler delivers the brief within a minute.";
const FAILED = "Could not queue the Morning Brief. Try again.";

/** The card is mounted only when the debug and native switches are both on. */
function bothSwitches(): Record<string, boolean> {
  return {
    [FeatureSwitchKey.OkouDebug]: true,
    [FeatureSwitchKey.SimpleMorningBrief]: true,
  };
}

function triggerButton(): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === TRIGGER;
  });
  if (!button) {
    throw new Error(`Expected a button named "${TRIGGER}"`);
  }
  return button;
}

/** The Debug section itself, which proves the page reached Debug preferences. */
async function openedDebugSection(): Promise<HTMLElement> {
  return await screen.findByText("Capture network bodies");
}

function buttonNames(): (string | undefined)[] {
  return queryAllByRoleFast("button").map((candidate) => {
    return candidate.textContent?.trim();
  });
}

/** Accept the trigger so a successful press reaches its queued confirmation. */
function installTrigger(): void {
  context.mocks.api(morningBriefDebugTriggerContract.trigger, ({ respond }) => {
    return respond(200, {
      status: "queued",
      scheduledFor: "2026-09-20T06:00:00.000Z",
    });
  });
}

test("A developer queues a Morning Brief and is told it is only queued", async () => {
  installTrigger();

  await setupPage({
    context,
    path: DEBUG_PATH,
    featureSwitches: bothSwitches(),
  });
  await openedDebugSection();

  // The copy has to say the cost out loud: this produces a real brief and a
  // real email, and firing early yields two briefs that morning.
  const description = await screen.findByText(
    /Run a real Morning Brief now\./u,
  );
  expect(description).toHaveTextContent(
    "delivers a real brief and a real email",
  );
  expect(description).toHaveTextContent("two briefs that morning");
  // Nothing is queued until the developer asks for it.
  expect(screen.queryByRole("status")).toBeNull();

  click(triggerButton());

  await expect(screen.findByRole("status")).resolves.toHaveTextContent(QUEUED);
});

test("A pending trigger disables the button until the request settles", async () => {
  const requestStarted = createDeferredPromise<void>(context.signal);
  const response = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    morningBriefDebugTriggerContract.trigger,
    async ({ respond }) => {
      if (!requestStarted.settled()) {
        requestStarted.resolve(undefined);
      }
      await response.promise;
      return respond(200, {
        status: "queued",
        scheduledFor: "2026-09-20T06:00:00.000Z",
      });
    },
  );

  await setupPage({
    context,
    path: DEBUG_PATH,
    featureSwitches: bothSwitches(),
  });
  await openedDebugSection();

  click(triggerButton());

  await act(async () => {
    await requestStarted.promise;
  });
  await waitFor(() => {
    expect(screen.getByText("Queueing…")).toBeInTheDocument();
  });
  // The button is replaced by its pending label, so it cannot be pressed again.
  expect(buttonNames()).not.toContain(TRIGGER);

  response.resolve(undefined);
  await expect(screen.findByRole("status")).resolves.toHaveTextContent(QUEUED);
});

test("A refused trigger surfaces the failure in the card", async () => {
  context.mocks.api(morningBriefDebugTriggerContract.trigger, ({ respond }) => {
    return respond(409, {
      error: {
        code: "MORNING_BRIEF_RUN_IN_FLIGHT",
        message: "A Morning Brief run is already in flight for this member.",
      },
    });
  });

  await setupPage({
    context,
    path: DEBUG_PATH,
    featureSwitches: bothSwitches(),
  });
  await openedDebugSection();

  click(triggerButton());

  await expect(screen.findByRole("alert")).resolves.toHaveTextContent(FAILED);
  expect(screen.queryByRole("status")).toBeNull();
});

test("The card is absent from Debug while the native pipeline switch is off", async () => {
  // No trigger handler is registered: MSW fails the test on any request the
  // gated card should not be able to make.
  await setupPage({
    context,
    path: DEBUG_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  // The rest of Debug is present, so the card's own gate is what removed it.
  await openedDebugSection();

  expect(buttonNames()).not.toContain(TRIGGER);
});

test("The card is absent while the debug switch is off", async () => {
  await setupPage({
    context,
    path: DEBUG_PATH,
    featureSwitches: { [FeatureSwitchKey.SimpleMorningBrief]: true },
  });
  await expect(screen.findByText("Language")).resolves.toBeInTheDocument();

  expect(screen.queryByText("Capture network bodies")).toBeNull();
  expect(buttonNames()).not.toContain(TRIGGER);
});

test("Dismissing Settings aborts a trigger that is still in flight", async () => {
  const requestStarted = createDeferredPromise<void>(context.signal);
  const aborted = createDeferredPromise<void>(context.signal);
  context.mocks.api(
    morningBriefDebugTriggerContract.trigger,
    async ({ never, signal }) => {
      signal.addEventListener("abort", () => {
        if (!aborted.settled()) {
          aborted.resolve(undefined);
        }
      });
      if (!requestStarted.settled()) {
        requestStarted.resolve(undefined);
      }
      return await never();
    },
  );

  await setupPage({
    context,
    path: DEBUG_PATH,
    featureSwitches: bothSwitches(),
  });
  await openedDebugSection();

  click(triggerButton());
  await act(async () => {
    await requestStarted.promise;
  });

  click(screen.getByLabelText("Close"));

  // The card hands the Settings action signal to the request, so dismissal
  // cancels it instead of leaving it running behind a closed dialog.
  await act(async () => {
    await aborted.promise;
  });
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
  });
});
