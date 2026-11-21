import { expect, test, vi } from "vitest";
import { screen } from "@testing-library/react";
import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

// Capture delivery at the analytics SDK boundary, before background batching.
const { ingest } = vi.hoisted(() => {
  return {
    ingest:
      vi.fn<(_dataset: string, records: readonly { name: string }[]) => void>(),
  };
});
vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      ingest = ingest;
      flush() {
        return Promise.resolve();
      }
    },
  };
});

const context = testContext();
test("onboarding-start-005 the staging onboarding page reports its start to staging Marketing", async () => {
  const start = createDeferredPromise<string>(context.signal);
  context.mocks.api(
    marketingEventsContract.record,
    ({ body, request, respond }) => {
      if (body.tag === "onboarding-start" && !start.settled()) {
        start.resolve(request.url);
      }
      return respond(204);
    },
  );
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    host: "staging-app.omby.ai",
    path: "/onboarding",
  });
  await screen.findByRole("heading", { name: "What kind of work do you do?" });
  await expect(start.promise).resolves.toBe(
    "https://staging-www.omby.ai/api/events",
  );
});

test("onboarding-start-004 an onboarded member reaches the composer without a Marketing telemetry event", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: false,
    onboardingComplete: true,
  });
  await setupPage({
    context,
    path: "/onboarding",
    host: "app.okou.ai",
    env: { VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "local-onboarding-telemetry" },
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
  const records = ingest.mock.calls.flatMap(([, batch]) => {
    return batch;
  });
  expect(records).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        "attributes.http.route": "/api/onboarding/status",
      }),
    ]),
  );
  expect(
    records.some((record) => {
      return record.name === "marketing.event.send";
    }),
  ).toBeFalsy();
});
