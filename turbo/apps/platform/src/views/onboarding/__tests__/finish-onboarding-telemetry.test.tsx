import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { localStorageSignals } from "../../../signals/external/local-storage.ts";

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
const ENDPOINT = "https://www.okou.ai/api/marketing/finish-onboarding";
const REQUEST_ID = "ff61981b-5aaf-478d-a690-e39f5eb9d249";
const previousAttempts = localStorageSignals("marketing_onboarding_attempts");
const pageOptions = {
  context,
  path: "/onboarding",
  host: "app.okou.ai",
  env: { VITE_AXIOM_CLIENT_TELEMETRY_TOKEN: "test-onboarding-telemetry" },
} as const;

function onboardingNeeded() {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
}

async function expectOnboarding() {
  await expect(
    screen.findByRole("heading", {
      name: "What do you want to make first",
    }),
  ).resolves.toBeInTheDocument();
}

function handoffEvents(): Record<string, unknown>[] {
  return axiomTelemetry.ingest.mock.calls.flatMap(([dataset, events]) => {
    expect(dataset).toBe("vm0-client-telemetry-prod");
    return events.filter((event) => {
      return event.name === "marketing.onboarding";
    });
  });
}

async function expectCompletion(result: string) {
  await waitFor(() => {
    expect(handoffEvents()).toContainEqual(
      expect.objectContaining({
        "attributes.custom": expect.objectContaining({
          "okou.marketing.onboarding.phase": "complete",
          "okou.marketing.onboarding.result": result,
        }),
      }),
    );
  });
}

test("Report a bodyless handoff acknowledgement with bounded operational context", async () => {
  onboardingNeeded();
  const received = context.mocks.deferred<Request>();
  context.mocks.http.post(ENDPOINT, ({ request }) => {
    received.resolve(request);
    return new Response(null, {
      status: 204,
      headers: { "X-Marketing-Request-Id": REQUEST_ID },
    });
  });

  await setupPage({
    ...pageOptions,
    path: "/onboarding?gclid=private-click&utm_campaign=private-campaign",
  });
  await expectOnboarding();
  await expectCompletion("acknowledged");

  const request = await received.promise;
  expect(request.credentials).toBe("include");
  expect(request.keepalive).toBeTruthy();
  expect(request.headers.get("authorization")).toBe("Bearer test-token");
  expect(request.headers.has("content-type")).toBeFalsy();
  expect(request.headers.has("X-Marketing-Request-Id")).toBeFalsy();
  await expect(request.text()).resolves.toBe("");

  const events = handoffEvents();
  expect(events).toHaveLength(4);
  expect(events.at(-1)).toMatchObject({
    "attributes.custom": {
      "okou.client.outcome": "success",
      "okou.marketing.onboarding.user_id": "test-user-123",
      "okou.marketing.onboarding.org_id": "org_default",
      "okou.marketing.onboarding.request_id": REQUEST_ID,
    },
    "attributes.http.response.status_code": 204,
    "service.version": "0.540.0",
    "status.code": "OK",
  });
  const payload = JSON.stringify(events);
  for (const forbidden of [
    "test-token",
    "private-click",
    "private-campaign",
    "https://",
    "Cookie",
  ]) {
    expect(payload).not.toContain(forbidden);
  }
});

test.each([200, 401, 500])(
  "Keep onboarding usable and report HTTP %i as an unsuccessful handoff",
  async (status) => {
    onboardingNeeded();
    context.mocks.http.post(ENDPOINT, () => {
      return new Response("private-invalid-json", {
        status,
        headers: {
          "Content-Type": "application/json",
          "X-Marketing-Request-Id": "private-untrusted-header",
        },
      });
    });

    await setupPage(pageOptions);
    await expectOnboarding();
    await expectCompletion("http_error");
    expect(handoffEvents().at(-1)).toMatchObject({
      "attributes.http.response.status_code": status,
      "status.code": "ERROR",
    });
    const payload = JSON.stringify(handoffEvents());
    expect(payload).not.toContain("private-invalid-json");
    expect(payload).not.toContain("private-untrusted-header");
  },
);

test("Report a network failure without blocking onboarding", async () => {
  onboardingNeeded();
  context.mocks.http.post(ENDPOINT, () => {
    return Response.error();
  });
  await setupPage(pageOptions);
  await expectOnboarding();
  await expectCompletion("request_error");
});

test("Distinguish a missing token from an attempted request", async () => {
  onboardingNeeded();
  await setupPage({
    ...pageOptions,
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      session: { token: "" },
    },
  });
  await expectOnboarding();
  await expectCompletion("token_missing");
});

test("Explain a persisted previous attempt without sending another request", async () => {
  onboardingNeeded();
  context.store.set(previousAttempts.set$, "test-user-123:org_default");
  await setupPage(pageOptions);
  await expectOnboarding();
  await expectCompletion("duplicate_attempt");
});

test("Record cancellation when the owning session changes during the request", async () => {
  onboardingNeeded();
  const received = context.mocks.deferred<void>();
  const response = context.mocks.deferred<void>();
  context.mocks.http.post(ENDPOINT, async () => {
    received.resolve();
    await response.promise;
    return new Response(null, { status: 204 });
  });

  await setupPage(pageOptions);
  await expectOnboarding();
  await received.promise;
  const switched = window._okou?.switchClerkSession("another-test-session");
  await expectCompletion("aborted");
  response.resolve();
  await switched;
});

test.each(["Error", "AbortError"])(
  "A synchronous telemetry %s cannot prevent the onboarding handoff",
  async (errorName) => {
    onboardingNeeded();
    axiomTelemetry.ingest.mockImplementation((_dataset, events) => {
      if (
        events.some((event) => {
          return event.name === "marketing.onboarding";
        })
      ) {
        const error = new Error("Telemetry unavailable");
        error.name = errorName;
        throw error;
      }
    });
    const received = context.mocks.deferred<Request>();
    context.mocks.http.post(ENDPOINT, ({ request }) => {
      received.resolve(request);
      return new Response(null, { status: 204 });
    });

    await setupPage(pageOptions);
    await expectOnboarding();
    const request = await received.promise;
    expect(request.headers.get("authorization")).toBe("Bearer test-token");
    await expect(request.text()).resolves.toBe("");
  },
);
