// @vitest-environment-options {"url":"https://app.okou.ai"}
import { screen } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
  await expect(
    setupPage({ context, path: RUN_PATH, sharedWorkerTestTransport: "direct" }),
  ).rejects.toMatchObject({ status: 426 });
  await expect(
    screen.findByRole("dialog", { name: "Update required" }),
  ).resolves.toBeInTheDocument();
});
