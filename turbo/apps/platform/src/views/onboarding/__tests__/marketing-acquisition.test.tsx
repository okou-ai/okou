import { screen } from "@testing-library/react";
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

async function openOnboarding() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({ context, path: "/onboarding", host: "app.okou.ai" });
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
  return { recorded: true, shadowEnabled: true, consented: true };
}

test("consented shadow observations use the authenticated cookie request and survive onboarding navigation", async () => {
  context.mocks.http.get(`${BASE}/config`, () => {
    return Response.json({ shadowEnabled: true });
  });
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
  await openOnboarding();
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

test("a disabled shadow configuration leaves onboarding usable without acquisition requests", async () => {
  const configured = context.mocks.deferred<void>();
  context.mocks.http.get(`${BASE}/config`, () => {
    configured.resolve();
    return Response.json({ shadowEnabled: false });
  });
  const requests: Request[] = [];
  context.mocks.http.post(`${BASE}/events`, ({ request }) => {
    requests.push(request);
    return Response.json(accepted());
  });
  await openOnboarding();
  await configured.promise;
  chooseWorkflow();
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  expect(requests).toStrictEqual([]);
});

test("missing consent never sends buffered observations or writes a tab identifier", async () => {
  context.mocks.http.get(`${BASE}/config`, () => {
    return Response.json({ shadowEnabled: true });
  });
  const skipped = context.mocks.deferred<void>();
  const batches: ObservationBatch[] = [];
  context.mocks.http.post(`${BASE}/events`, async ({ request }) => {
    batches.push(
      marketingAcquisitionContract.events.body.parse(await request.json()),
    );
    skipped.resolve();
    return Response.json({ ...accepted(), consented: false });
  });
  await openOnboarding();
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
  context.mocks.http.get(`${BASE}/config`, () => {
    return Response.json({ shadowEnabled: true });
  });
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
  await openOnboarding();
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
