import { voiceIoQuotaContract } from "@okouai/api-contracts/contracts/voice-io-quota";
import { screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { initSentry } from "../../../lib/sentry.ts";
import {
  context,
  findEnabledButton,
  installRunChat,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

test.each(["direct", "message-port"] as const)(
  "show the upgrade dialog for headerless event-row 426 using %s transport",
  async (transport) => {
    installRunChat();
    context.mocks.http.get("*/api/chat-threads/:threadId/event-rows", () => {
      return Response.json(
        {
          error: {
            code: "CLIENT_UPGRADE_REQUIRED",
            message: "Client update required",
          },
        },
        { status: 426 },
      );
    });
    await setupPage({
      context,
      path: RUN_PATH,
      sharedWorkerTestTransport: transport,
    });
    await expect(
      screen.findByRole("dialog", { name: "Update required" }),
    ).resolves.toBeVisible();
    await expect(findEnabledButton("Refresh")).resolves.toBeVisible();
  },
);

test("keep microphone guidance and retry after permission denial", async () => {
  installRunChat();
  context.mocks.api(voiceIoQuotaContract.get, ({ respond }) => {
    return respond(200, { allowed: true, count: 0, limit: 60 });
  });
  context.mocks.browser.voiceInput({ rms: 0.12 });
  const denied = new DOMException(
    "Permission denied by system",
    "NotAllowedError",
  );
  vi.spyOn(navigator.mediaDevices, "getUserMedia").mockRejectedValueOnce(
    denied,
  );
  const consoleErrors: unknown[][] = [];
  const consoleError = vi.spyOn(console, "error");
  const original = consoleError.getMockImplementation();
  if (!original) {
    throw new Error("Expected the shared console error guard");
  }
  consoleError.mockImplementation((...args: unknown[]) => {
    if (args.includes(denied)) {
      consoleErrors.push(args);
      return;
    }
    original(...args);
  });
  const sentry = context.mocks.sentry();
  initSentry();
  await setupPage({
    context,
    path: RUN_PATH,
  });
  const composer = screen.getByRole("textbox", { name: "Message" });
  await fill(composer, "Keep these notes.");
  click(await findEnabledButton("Voice input"));
  await expect(
    screen.findByText(
      "Microphone access was denied. Allow microphone access and try again.",
    ),
  ).resolves.toBeVisible();
  const retry = await findEnabledButton("Voice input");
  expect(composer).toHaveTextContent("Keep these notes.");
  expect(consoleErrors).not.toHaveLength(0);
  const report = sentry.reports.find((candidate) => {
    return candidate.type === "exception" && candidate.error === denied;
  });
  expect(report).toBeDefined();
  const beforeSend = sentry.initializations.at(-1)?.options?.beforeSend;
  if (!beforeSend || report?.type !== "exception") {
    throw new Error("Expected the microphone capture and Sentry delivery hook");
  }
  await expect(
    Promise.resolve(
      beforeSend(
        {
          type: undefined,
          exception: {
            values: [{ type: denied.name, value: denied.message }],
          },
        },
        { originalException: report.error },
      ),
    ),
  ).resolves.toBeNull();
  click(retry);
  await expect(findEnabledButton("Stop recording")).resolves.toBeVisible();
});
