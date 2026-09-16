import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import userEvent from "@testing-library/user-event";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const ENDPOINT = "https://www.okou.ai/api/marketing/acquisition/onboarding";
const previousAttempts = localStorageSignals("acquisition_onboarding_attempts");

function goBack() {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.trim() === "Back";
  });
  if (!button) {
    throw new Error("Expected the onboarding Back button");
  }
  click(button);
}

function selectWorkflowAutomation() {
  const radio = queryAllByRoleFast("radio").find((candidate) => {
    return candidate.textContent?.includes("Workflow automation");
  });
  if (!radio) {
    throw new Error("Expected the Workflow automation option");
  }
  click(radio);
}

function onboardingNeeded() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

async function openOnboarding(enabled: boolean | undefined = true) {
  await setupPage({
    context,
    path: "/onboarding",
    host: "app.okou.ai",
    featureSwitches:
      enabled === undefined
        ? {}
        : { [FeatureSwitchKey.MarketingAcquisitionShadow]: enabled },
  });
  await expect(
    screen.findByRole("heading", {
      name: "What do you want to make first",
    }),
  ).resolves.toBeInTheDocument();
}

test("Onboarding sends one bearer-authenticated request while steps remain usable without an iframe", async () => {
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
  expect(request.headers.get("authorization")).toBe("Bearer test-token");
  expect(request.headers.has("content-type")).toBeFalsy();
  await expect(request.text()).resolves.toBe("");
  expect(document.querySelector("iframe")).toBeNull();

  selectWorkflowAutomation();
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("online"));
  goBack();
  await expect(
    screen.findByRole("heading", {
      name: "What do you want to make first",
    }),
  ).resolves.toBeInTheDocument();
  expect(requests).toHaveLength(1);
  expect(context.store.get(previousAttempts.get$)).toBe(
    "test-user-123:org_default",
  );
  expect(request.signal.aborted).toBeFalsy();
  complete.resolve();
});

test.each(["http", "unauthorized", "network"])(
  "A %s failure does not block onboarding or retry on navigation",
  async (failure) => {
    onboardingNeeded();
    const received = context.mocks.deferred<void>();
    let requests = 0;
    context.mocks.http.post(ENDPOINT, () => {
      requests++;
      received.resolve();
      return failure === "network"
        ? Response.error()
        : new Response(null, {
            status: failure === "unauthorized" ? 401 : 503,
          });
    });
    await openOnboarding();
    await received.promise;
    selectWorkflowAutomation();
    await expect(
      screen.findByRole("heading", { name: "What do you work on?" }),
    ).resolves.toBeInTheDocument();
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    goBack();
    await expect(
      screen.findByRole("heading", {
        name: "What do you want to make first",
      }),
    ).resolves.toBeInTheDocument();
    expect(requests).toBe(1);
  },
);

test("A missing session token skips attribution while onboarding remains usable", async () => {
  onboardingNeeded();
  let requests = 0;
  context.mocks.http.post(ENDPOINT, () => {
    requests++;
    return new Response(null, { status: 204 });
  });
  await setupPage({
    context,
    path: "/onboarding",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarketingAcquisitionShadow]: true },
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      session: { token: "" },
    },
  });
  await expect(
    screen.findByRole("heading", { name: "What do you want to make first" }),
  ).resolves.toBeInTheDocument();
  selectWorkflowAutomation();
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  expect(requests).toBe(0);
});

test("An already onboarded user sends no attribution request", async () => {
  let requests = 0;
  context.mocks.http.post(ENDPOINT, () => {
    requests++;
    return new Response(null, { status: 204 });
  });
  await setupPage({
    context,
    path: "/onboarding",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.MarketingAcquisitionShadow]: true },
  });
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
  selectWorkflowAutomation();
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

test.each(["default", "disabled"])(
  "The %s App switch skips acquisition while Impact and onboarding remain usable",
  async (mode) => {
    onboardingNeeded();
    const requests: Request[] = [];
    let impactRequests = 0;
    context.mocks.http.post(ENDPOINT, ({ request }) => {
      requests.push(request);
      return new Response(null, { status: 204 });
    });
    context.mocks.http.post(
      "https://www.okou.ai/api/marketing/impact/onboarding",
      () => {
        impactRequests++;
        return new Response(null, { status: 204 });
      },
    );
    await setupPage({
      context,
      path: "/onboarding",
      host: "app.okou.ai",
      featureSwitches:
        mode === "default"
          ? {}
          : { [FeatureSwitchKey.MarketingAcquisitionShadow]: false },
    });
    await screen.findByRole("heading", {
      name: "What do you want to make first",
    });
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    selectWorkflowAutomation();
    await screen.findByRole("heading", { name: "What do you work on?" });
    expect(requests).toStrictEqual([]);
    expect(context.store.get(previousAttempts.get$)).toBeNull();
    expect(impactRequests).toBe(1);
  },
);

test("Toggling the Lab switch outside onboarding does not trigger acquisition", async () => {
  let requests = 0;
  context.mocks.http.post(ENDPOINT, () => {
    requests++;
    return new Response(null, { status: 204 });
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
  await waitFor(() => {
    expect(control).toBeChecked();
  });
  await user.click(control);
  await waitFor(() => {
    expect(control).not.toBeChecked();
  });
  expect(requests).toBe(0);
  expect(context.store.get(previousAttempts.get$)).toBeNull();
});
