import { marketingEventsContract } from "@okouai/api-contracts/contracts/marketing-events";
import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

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
const INDUSTRY_QUESTION = "What kind of work do you do?";
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
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
  ).resolves.toBeInTheDocument();
}

test("Onboarding sends an authenticated event without waiting, with one attempt record before the POST", async () => {
  onboardingNeeded();
  const received = context.mocks.deferred<Request>();
  const complete = context.mocks.deferred<void>();
  context.mocks.api(
    marketingEventsContract.record,
    async ({ request, body, respond }) => {
      expect(request.url).toBe(ENDPOINT);
      expect(body).toStrictEqual({
        tag: "onboarding-start",
        eventId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
        ),
      });
      expect(marketingEvents()).toHaveLength(1);
      expect(marketingEvents()[0]).toMatchObject({
        "attributes.custom": {
          "okou.client.outcome": "started",
          "okou.marketing.event.tag": "onboarding-start",
          "okou.marketing.event.user_id": "test-user-123",
          "okou.marketing.event.org_id": "org_default",
        },
        "scope.name": "okou-app/marketing",
      });
      expect(marketingEvents()[0]).not.toHaveProperty("status.code");
      received.resolve(request);
      await complete.promise;
      return respond(204);
    },
  );

  await openOnboarding();
  const request = await received.promise;
  expect(request.credentials).toBe("include");
  expect(request.headers.get("authorization")).toBe("Bearer test-token");
  expect(request.headers.get("content-type")).toBe("application/json");
  expect(request.signal.aborted).toBeFalsy();
  complete.resolve();
});

test.each([503])(
  "A Marketing %s response does not produce another telemetry record or block onboarding",
  async (status) => {
    onboardingNeeded();
    const received = context.mocks.deferred<void>();
    context.mocks.http.post(ENDPOINT, () => {
      received.resolve();
      return status === 204
        ? new Response(null, { status })
        : Response.json(
            { code: "TEST_FAILURE", error: "Marketing unavailable" },
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
      screen.getByRole("heading", { name: INDUSTRY_QUESTION }),
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
  await expect(
    screen.findByRole("heading", { name: INDUSTRY_QUESTION }),
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
    screen.getByRole("heading", { name: INDUSTRY_QUESTION }),
  ).toBeInTheDocument();
});
