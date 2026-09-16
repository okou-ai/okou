import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { marketingAcquisitionContract } from "@okouai/api-contracts/contracts/marketing-acquisition";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { sessionStorageSignals } from "../../../signals/external/session-storage.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const BASE = "https://www.okou.ai/api/marketing/acquisition";
type ObservationBatch = ReturnType<
  typeof marketingAcquisitionContract.events.body.parse
>;

async function openOnboarding(enabled?: boolean) {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    path: "/onboarding",
    host: "app.okou.ai",
    ...(enabled === undefined
      ? {}
      : {
          featureSwitches: {
            [FeatureSwitchKey.MarketingAcquisitionShadow]: enabled,
          },
        }),
  });
  await expect(
    screen.findByRole("heading", { name: "What do you want to make first" }),
  ).resolves.toBeInTheDocument();
}
function chooseWorkflow() {
  const radio = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.textContent?.includes("Workflow automation");
  });
  if (!radio) {
    throw new Error("Expected workflow choice");
  }
  click(radio);
}

const tabSession = sessionStorageSignals("okou.acquisitionSession");
function accepted() {
  return { recorded: true, consented: true };
}

test("consented shadow observations use the authenticated cookie request and survive onboarding navigation", async () => {
  const observed = context.mocks.deferred<{
    request: Request;
    body: ObservationBatch;
  }>();
  context.mocks.http.post(`${BASE}/events`, async ({ request }) => {
    const body = marketingAcquisitionContract.events.body.parse(
      await request.json(),
    );
    if (body.events.length) {
      observed.resolve({ request, body });
    }
    return Response.json(accepted());
  });
  await openOnboarding(true);
  const { request, body } = await observed.promise;
  expect(request.headers.get("authorization")).toBe("Bearer test-token");
  expect(request.credentials).toBe("include");
  expect(body.events).toStrictEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "StepViewed",
        properties: expect.objectContaining({ step_key: "make" }),
      }),
    ]),
  );
  expect(body.sessionId).toStrictEqual(expect.any(String));
  expect(document.querySelector("iframe")).toBeNull();
  chooseWorkflow();
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
});

test.each([undefined, false])(
  "a default or explicitly disabled App switch (%s) leaves onboarding usable without acquisition requests",
  async (enabled) => {
    const requests: Request[] = [];
    context.mocks.http.get(`${BASE}/config`, ({ request }) => {
      requests.push(request);
      return Response.json({});
    });
    context.mocks.http.post(`${BASE}/events`, ({ request }) => {
      requests.push(request);
      return Response.json(accepted());
    });
    await openOnboarding(enabled);
    chooseWorkflow();
    await expect(
      screen.findByRole("heading", { name: "What do you work on?" }),
    ).resolves.toBeInTheDocument();
    expect(requests).toStrictEqual([]);
  },
);

test("missing consent never sends buffered observations or writes a tab identifier", async () => {
  const skipped = context.mocks.deferred<void>();
  const batches: ObservationBatch[] = [];
  context.mocks.http.post(`${BASE}/events`, async ({ request }) => {
    batches.push(
      marketingAcquisitionContract.events.body.parse(await request.json()),
    );
    skipped.resolve();
    return Response.json({ ...accepted(), consented: false });
  });
  await openOnboarding(true);
  await skipped.promise;
  chooseWorkflow();
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  expect(
    batches.every((batch) => {
      return batch.events.length === 0 && batch.sessionId === undefined;
    }),
  ).toBeTruthy();
  expect(context.store.get(tabSession.get$)).toBeNull();
});

test("an unacknowledged batch keeps its event IDs when a later step resumes delivery", async () => {
  const failed = context.mocks.deferred<ObservationBatch>();
  const retried = context.mocks.deferred<ObservationBatch>();
  let rejected = false;
  context.mocks.http.post(`${BASE}/events`, async ({ request }) => {
    const body = marketingAcquisitionContract.events.body.parse(
      await request.json(),
    );
    if (body.events.length && !rejected) {
      rejected = true;
      failed.resolve(body);
      return Response.json({ error: "Retry later" }, { status: 503 });
    }
    if (body.events.length) {
      retried.resolve(body);
    }
    return Response.json(accepted());
  });
  await openOnboarding(true);
  const original = await failed.promise;
  chooseWorkflow();
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  window.dispatchEvent(new Event("online"));
  const replay = await retried.promise;
  expect(
    replay.events.map((event) => {
      return event.id;
    }),
  ).toStrictEqual(
    expect.arrayContaining(
      original.events.map((event) => {
        return event.id;
      }),
    ),
  );
});

test("the Lab switch starts observations and cancels an in-flight request when disabled", async () => {
  const started = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.http.post(`${BASE}/events`, async ({ request }) => {
    request.signal.addEventListener(
      "abort",
      () => {
        aborted.resolve();
        response.resolve();
      },
      { once: true },
    );
    started.resolve();
    await response.promise;
    return Response.json(accepted());
  });
  let switches: Record<string, boolean> = {
    [FeatureSwitchKey.Lab]: true,
    [FeatureSwitchKey.MarketingAcquisitionShadow]: false,
  };
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches, effectiveSwitches: switches });
  });
  context.mocks.api(featureSwitchesContract.update, ({ body, respond }) => {
    switches = { ...switches, ...body.switches };
    return respond(200, { switches, effectiveSwitches: switches });
  });
  await setupPage({ context, path: "/_/lab", host: "app.okou.ai" });
  await screen.findByRole("heading", { name: "Lab" });
  const row = screen
    .getByText(FeatureSwitchKey.MarketingAcquisitionShadow)
    .closest("li");
  if (!(row instanceof HTMLElement)) {
    throw new Error("Expected Marketing acquisition feature row");
  }
  const control = within(row).getByRole("switch");
  expect(control).not.toBeChecked();
  const user = userEvent.setup();
  await user.click(control);
  await started.promise;
  await waitFor(() => {
    expect(control).toBeChecked();
  });
  await user.click(control);
  await aborted.promise;
  await waitFor(() => {
    expect(control).not.toBeChecked();
  });
  expect(context.store.get(tabSession.get$)).toBeNull();
});
