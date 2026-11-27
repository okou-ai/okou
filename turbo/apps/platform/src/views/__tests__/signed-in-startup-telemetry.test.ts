// @vitest-environment-options {"url":"https://app.okou.ai/","settings":{"disableIframePageLoading":true,"disableCSSFileLoading":true,"handleDisabledFileLoadingAsSuccess":true}}
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { startPlatformEntrypoint } from "../../lib/platform-entrypoint.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";
import { prepareSignedOutDocument } from "./entrypoint-fixture.ts";
const context = testContext();

test("startup-diagnostics-003 A signed-in missing conversation publishes anonymous first paint and chat timing from one application startup", async () => {
  const thread = crypto.randomUUID();
  const { posthog } = prepareSignedOutDocument(
    context,
    "https://app.okou.ai/chats/" + thread + "?private=field-notes",
  );
  const clerk = context.mocks.clerk();
  clerk.user(
    { id: "measurement-member", fullName: "Measurement member" },
    { token: "measurement-token" },
  );
  clerk.organization({
    activeOrg: { id: "measurement-org", name: "Measurement org" },
    memberships: [{ id: "measurement-org" }],
  });
  clerk.sessionSignedOut(false);
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: [],
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  const original = performance.getEntriesByType.bind(performance);
  vi.spyOn(performance, "getEntriesByType").mockImplementation((type) => {
    if (type === "navigation") {
      return [
        {
          entryType: type,
          name: location.href,
          responseStart: 7.2,
          responseEnd: 19.8,
        },
      ] as PerformanceNavigationTiming[];
    }
    if (type === "paint") {
      return [
        { entryType: type, name: "first-contentful-paint", startTime: 36.6 },
      ] as PerformanceEntry[];
    }
    return original(type);
  });
  window.__appBootstrapStart = performance.now() - 12;
  try {
    startPlatformEntrypoint();
    await screen.findByText("Chat thread not found");
    await waitFor(() => {
      return expect(
        posthog.events.map((item) => {
          return item.name;
        }),
      ).toContain("app_bootstrap_phase_timing");
    });
    const phases = posthog.events.filter((event) => {
      return event.name === "app_bootstrap_phase_timing";
    });
    expect(phases).toHaveLength(1);
    const timing = phases[0]?.properties;
    expect(timing).toMatchObject({
      initial_route: "/chats/:threadId",
      final_route: "/chats/:threadId",
      thread_metadata_source: "not_found",
    });
    for (const field of [
      "entry_module_ready_ms",
      "skeleton_duration_ms",
      "locale_init_ms",
      "route_setup_ms",
      "local_thread_metadata_ms",
      "remote_thread_metadata_ms",
    ]) {
      const value = timing?.[field];
      expect(Number.isFinite(value)).toBeTruthy();
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(timing)).not.toContain(thread);
    const paint = posthog.events.find((event) => {
      return event.name === "app_first_skeleton_paint";
    });
    const pixels = {
      navigation_response_end_ms: 20,
      navigation_response_start_ms: 7,
      paint_metric: "first-contentful-paint",
      response_end_to_skeleton_paint_ms: 17,
      skeleton_paint_ms: 37,
    };
    expect(paint?.properties).toStrictEqual(pixels);
    const sdk = posthog.initializations.at(-1);
    const sanitize = sdk?.config?.before_send;
    if (typeof sanitize !== "function" || !paint || !sdk) {
      throw new Error(
        "The analytics SDK did not receive paint and its sanitizer",
      );
    }
    const clean = sanitize({
      event: paint.name,
      uuid: crypto.randomUUID(),
      properties: {
        ...paint.properties,
        $current_url: location.href,
        distinct_id: "measurement-member",
        private_note: "field-notes",
        token: sdk.key,
      },
    });
    expect(clean?.properties).toStrictEqual({
      ...pixels,
      token: sdk.key,
      distinct_id: "app-bootstrap",
      $process_person_profile: false,
    });
    expect(JSON.stringify(clean)).not.toMatch(
      /measurement-member|field-notes/u,
    );
  } finally {
    delete window.__appBootstrapStart;
  }
});
