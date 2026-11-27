import { findFastControl } from "./chat-message-experience-test-helpers.ts";
// @vitest-environment-options {"url":"https://app.okou.ai"}
import { initSentry } from "../../../lib/sentry.ts";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

// @vitest-environment-options {"url":"https://app.okou.ai"}

const context = testContext();

test("chat-expected-failures-001 a headerless client upgrade response during chat startup shows the update dialog", async () => {
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  context.mocks.http.get("*/api/chat-threads/:threadId/event-rows", () => {
    return HttpResponse.json(
      {
        error: { code: "CLIENT_UPGRADE_REQUIRED", message: "Update required" },
      },
      { status: 426 },
    );
  });
  await expect(setupPage({ context, path: RUN_PATH })).rejects.toMatchObject({
    status: 426,
  });
  await expect(
    screen.findByRole("dialog", { name: "Update required" }),
  ).resolves.toBeInTheDocument();
});

test("chat-expected-failures-003 the user can retry a reported microphone denial without losing their notes", async () => {
  const sentry = context.mocks.sentry();
  initSentry();
  context.mocks.browser.voiceInput({ rms: 0.3 });
  const denial = new DOMException(
    "Recording permission denied by user",
    "NotAllowedError",
  );
  vi.spyOn(navigator.mediaDevices, "getUserMedia").mockRejectedValueOnce(
    denial,
  );
  const logged: unknown[][] = [];
  const reporter = vi.spyOn(console, "error");
  const original = reporter.getMockImplementation();
  reporter.mockImplementation((...args) => {
    if (
      args.includes(denial) ||
      args.some((value) => {
        return (
          typeof value === "string" &&
          /[Mm]icrophone|[Rr]ecording permission denied/.test(value)
        );
      })
    ) {
      logged.push(args);
    } else {
      original?.(...args);
    }
  });
  mockChatLifecycle(context, { threadId: RUN_THREAD_ID });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await fill(editor, "Keep the field notes");
  click(await findFastControl("button", "Voice input"));
  await screen.findByText(
    "Microphone access was denied. Allow microphone access and try again.",
  );
  expect(editor).toHaveTextContent("Keep the field notes");
  click(await findFastControl("button", "Voice input"));
  await findFastControl("button", "Stop recording");
  expect(logged.flat()).toContain(denial);
  await waitFor(() => {
    expect(sentry.reports).toContainEqual(
      expect.objectContaining({ type: "exception", error: denial }),
    );
  });
});
