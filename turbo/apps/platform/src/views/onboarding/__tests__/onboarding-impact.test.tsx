import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const ENDPOINT = "https://www.okou.ai/api/marketing/impact/onboarding";
const previousAttempts = localStorageSignals("impact_onboarding_attempts");

function goBack() {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === "Back";
  });
  if (!button) {
    throw new Error("Expected the onboarding Back button");
  }
  click(button);
}

function onboardingNeeded() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

async function openOnboarding() {
  await setupPage({ context, path: "/onboarding", host: "app.okou.ai" });
  await expect(
    screen.findByRole("heading", {
      name: "What do you want to make first",
    }),
  ).resolves.toBeInTheDocument();
}

test("Onboarding sends one cookie request while steps remain usable without an iframe", async () => {
  onboardingNeeded();
  const received = context.mocks.deferred<Request>();
  const complete = context.mocks.deferred<void>();
  const requests: Request[] = [];
  context.mocks.http.post(ENDPOINT, async ({ request }) => {
    requests.push(request);
    received.resolve(request);
    await complete.promise;
    return new Response(null, { status: 204 });
  });

  await openOnboarding();
  const request = await received.promise;
  expect(request.credentials).toBe("include");
  expect(request.headers.has("authorization")).toBeFalsy();
  expect(request.headers.has("content-type")).toBeFalsy();
  await expect(request.text()).resolves.toBe("");
  expect(document.querySelector("iframe")).toBeNull();

  click(screen.getByRole("radio", { name: /Workflow automation/u }));
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  goBack();
  await expect(
    screen.findByRole("heading", {
      name: "What do you want to make first",
    }),
  ).resolves.toBeInTheDocument();
  expect(requests).toHaveLength(1);
  expect(request.signal.aborted).toBeFalsy();
  complete.resolve();
});

test.each(["http", "network"])(
  "A %s failure does not block onboarding or retry on navigation",
  async (failure) => {
    onboardingNeeded();
    const received = context.mocks.deferred<void>();
    let requests = 0;
    context.mocks.http.post(ENDPOINT, () => {
      requests++;
      received.resolve();
      return failure === "http"
        ? new Response(null, { status: 503 })
        : Response.error();
    });
    await openOnboarding();
    await received.promise;
    click(screen.getByRole("radio", { name: /Workflow automation/u }));
    await expect(
      screen.findByRole("heading", { name: "What do you work on?" }),
    ).resolves.toBeInTheDocument();
    goBack();
    await expect(
      screen.findByRole("heading", {
        name: "What do you want to make first",
      }),
    ).resolves.toBeInTheDocument();
    expect(requests).toBe(1);
  },
);

test("An already onboarded user sends no attribution request", async () => {
  let requests = 0;
  context.mocks.http.post(ENDPOINT, () => {
    requests++;
    return new Response(null, { status: 204 });
  });
  await setupPage({ context, path: "/onboarding", host: "app.okou.ai" });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(requests).toBe(0);
  expect(document.querySelector("iframe")).toBeNull();
});

test("A persisted attempt survives a reload for the same user and organization", async () => {
  onboardingNeeded();
  // Browser persistence from a previous document is an external initial state.
  context.store.set(previousAttempts.set$, "test-user-123:org_default");
  let requests = 0;
  context.mocks.http.post(ENDPOINT, () => {
    requests++;
    return new Response(null, { status: 204 });
  });
  await openOnboarding();
  click(screen.getByRole("radio", { name: /Workflow automation/u }));
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  expect(requests).toBe(0);
});

test("A different user's previous attempt does not suppress onboarding attribution", async () => {
  onboardingNeeded();
  context.store.set(previousAttempts.set$, "user_other:org_other");
  const received = context.mocks.deferred<void>();
  context.mocks.http.post(ENDPOINT, () => {
    received.resolve();
    return new Response(null, { status: 204 });
  });
  await openOnboarding();
  await received.promise;
  expect(document.querySelector("iframe")).toBeNull();
});
