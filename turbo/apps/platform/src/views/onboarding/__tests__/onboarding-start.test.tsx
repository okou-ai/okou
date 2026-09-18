import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";

const axiomTelemetry = vi.hoisted(() => {
  return {
    ingest:
      vi.fn<
        (dataset: string, events: readonly Record<string, unknown>[]) => void
      >(),
  };
});

vi.mock("@axiomhq/js", () => {
  return {
    Axiom: class {
      async flush(): Promise<void> {}

      ingest(
        dataset: string,
        events: readonly Record<string, unknown>[],
      ): void {
        axiomTelemetry.ingest(dataset, events);
      }
    },
  };
});

const context = testContext();
const ENDPOINT = "https://www.okou.ai/api/events";
const TELEMETRY_ENV = {
  VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "test-marketing-telemetry",
} as const;

function marketingEvents(): Record<string, unknown>[] {
  return axiomTelemetry.ingest.mock.calls.flatMap(([dataset, events]) => {
    expect(dataset).toBe("vm0-client-telemetry-prod");
    return events.filter((event) => {
      return event.name === "marketing.event.send";
    });
  });
}

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

async function openOnboarding() {
  await setupPage({
    context,
    path: "/onboarding",
    host: "app.okou.ai",
    env: TELEMETRY_ENV,
  });
  await expect(
    screen.findByRole("heading", { name: "What do you want to make first" }),
  ).resolves.toBeInTheDocument();
}

test("Onboarding sends authenticated events without waiting, with one attempt record before each POST", async () => {
  onboardingNeeded();
  const firstReceived = context.mocks.deferred<Request>();
  const secondReceived = context.mocks.deferred<Request>();
  const thirdReceived = context.mocks.deferred<Request>();
  const complete = context.mocks.deferred<void>();
  const eventIds: string[] = [];
  context.mocks.api(
    marketingEventsContract.record,
    async ({ request, body, respond }) => {
      eventIds.push(body.eventId);
      expect(request.url).toBe(ENDPOINT);
      expect(body).toStrictEqual({
        tag: "onboarding-start",
        eventId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
      });
      expect(marketingEvents()).toHaveLength(eventIds.length);
      expect(marketingEvents().at(-1)).toMatchObject({
        "attributes.custom": {
          "okou.client.outcome": "started",
          "okou.marketing.event.tag": "onboarding-start",
          "okou.marketing.event.user_id": "test-user-123",
          "okou.marketing.event.org_id": "org_default",
        },
        "scope.name": "okou-app/marketing",
      });
      expect(marketingEvents().at(-1)).not.toHaveProperty("status.code");
      const received =
        eventIds.length === 1
          ? firstReceived
          : eventIds.length === 2
            ? secondReceived
            : thirdReceived;
      received.resolve(request);
      await complete.promise;
      return respond(204);
    },
  );

  await openOnboarding();
  const first = await firstReceived.promise;
  expect(first.credentials).toBe("include");
  expect(first.headers.get("authorization")).toBe("Bearer test-token");
  expect(first.headers.get("content-type")).toBe("application/json");
  selectWorkflowAutomation();
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
  await secondReceived.promise;
  goBack();
  await expect(
    screen.findByRole("heading", { name: "What do you want to make first" }),
  ).resolves.toBeInTheDocument();
  await thirdReceived.promise;
  expect(new Set(eventIds).size).toBe(3);
  expect(first.signal.aborted).toBeFalsy();
  complete.resolve();
});

test.each([200, 204, 401, 503])(
  "A Marketing %s response does not produce another telemetry record or block onboarding",
  async (status) => {
    onboardingNeeded();
    const received = context.mocks.deferred<void>();
    context.mocks.http.post(ENDPOINT, () => {
      received.resolve();
      return status === 204
        ? new Response(null, { status })
        : Response.json(
            status === 200
              ? { code: "EVENT_RECORDED" }
              : { code: "TEST_FAILURE", error: "Marketing unavailable" },
            { status },
          );
    });
    await openOnboarding();
    await received.promise;
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("online"));
    expect(marketingEvents()).toHaveLength(1);
    expect(marketingEvents()[0]).toMatchObject({
      "attributes.custom": { "okou.client.outcome": "started" },
    });
    expect(
      screen.getByRole("heading", { name: "What do you want to make first" }),
    ).toBeInTheDocument();
  },
);

test("A missing session token is sent to Marketing for authentication without blocking onboarding", async () => {
  onboardingNeeded();
  const received = context.mocks.deferred<Request>();
  context.mocks.api(marketingEventsContract.record, ({ request, respond }) => {
    received.resolve(request);
    return respond(401, { code: "UNAUTHENTICATED", error: "Missing token" });
  });
  await setupPage({
    context,
    path: "/onboarding",
    host: "app.okou.ai",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      session: { token: "" },
    },
  });
  const request = await received.promise;
  expect(request.headers.has("authorization")).toBeFalsy();
  selectWorkflowAutomation();
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();
});

test("An already onboarded user continues into the app", async () => {
  await setupPage({
    context,
    path: "/onboarding",
    host: "app.okou.ai",
    env: TELEMETRY_ENV,
  });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeInTheDocument();
  expect(marketingEvents()).toHaveLength(0);
});

test("Preview onboarding sends to its matching Marketing environment", async () => {
  onboardingNeeded();
  const received = context.mocks.deferred<Request>();
  context.mocks.api(marketingEventsContract.record, ({ request, respond }) => {
    received.resolve(request);
    return respond(204);
  });
  await setupPage({
    context,
    path: "/onboarding",
    host: "staging-app.omby.ai",
  });
  const request = await received.promise;
  expect(request.url).toBe("https://staging-www.omby.ai/api/events");
  expect(
    screen.getByRole("heading", { name: "What do you want to make first" }),
  ).toBeInTheDocument();
});

test("Changing the session cancels the pending onboarding request", async () => {
  onboardingNeeded();
  const received = context.mocks.deferred<Request>();
  context.mocks.api(marketingEventsContract.record, ({ request, never }) => {
    received.resolve(request);
    return never();
  });

  await openOnboarding();
  const request = await received.promise;
  expect(request.signal.aborted).toBeFalsy();
  const switched = window._okou?.switchClerkSession("another-test-session");
  expect(request.signal.aborted).toBeTruthy();
  await switched;
});

test("Switching organizations during token acquisition does not send the old page event as the new organization", async () => {
  onboardingNeeded();
  const firstReceived = context.mocks.deferred<void>();
  const requests: Request[] = [];
  context.mocks.api(marketingEventsContract.record, ({ request, respond }) => {
    requests.push(request);
    firstReceived.resolve();
    return respond(204);
  });
  await openOnboarding();
  await firstReceived.promise;

  const tokenRequested = context.mocks.deferred<void>();
  const token = context.mocks.deferred<string>();
  mockedClerk.sessionGetToken.mockImplementation(() => {
    tokenRequested.resolve();
    return token.promise;
  });
  selectWorkflowAutomation();
  await tokenRequested.promise;
  await expect(
    screen.findByRole("heading", { name: "What do you work on?" }),
  ).resolves.toBeInTheDocument();

  const clerk = context.mocks.clerk();
  act(() => {
    clerk.organization({
      activeOrg: { id: "org_other", name: "Other workspace" },
      memberships: [{ id: "org_other" }],
    });
    clerk.stateChanged();
  });
  token.resolve("other-org-token");
  await waitFor(() => {
    expect(window.location.pathname).toBe("/");
  });
  expect(requests).toHaveLength(1);
  expect(marketingEvents()).toHaveLength(1);
});
