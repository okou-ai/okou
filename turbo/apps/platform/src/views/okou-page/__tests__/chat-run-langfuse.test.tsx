import { chatThreadByIdContract } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import {
  completedConversation,
  context,
  FIRST_CAPABILITY_RUN_ID,
  installCapabilityChat,
  readyChat,
  RUN_PATH,
  SECOND_CAPABILITY_RUN_ID,
} from "./chat-capability-test-helpers.ts";
import { publishRunUpdate } from "./chat-run-test-fixtures.ts";

const TRACE_URL = `https://langfuse.example/trace/${FIRST_CAPABILITY_RUN_ID.replaceAll("-", "")}`;
const TRACE_LABEL = "View Langfuse trace";

test("Link only the traced run beside Activity even after tracing is switched off", async () => {
  installCapabilityChat({
    events: completedConversation("Traced response", "Untraced response"),
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
      langfuseTraceUrls: { [FIRST_CAPABILITY_RUN_ID]: TRACE_URL },
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: true,
      [FeatureSwitchKey.LangfuseTrace]: false,
    },
  });
  await readyChat();

  const trace = await screen.findByLabelText(TRACE_LABEL);
  expect(trace).toHaveAttribute("href", TRACE_URL);
  expect(trace).toHaveAttribute("target", "_blank");
  expect(trace).toHaveAttribute("rel", "noopener noreferrer");
  const response = screen.getByText("Traced response");
  const group = response
    .closest('[data-role="assistant"]')
    ?.querySelector('[data-testid="chat-event-actions"]');
  if (!group) {
    throw new Error("Traced assistant response is missing");
  }
  expect(
    queryAllByRoleFast("link", group).map((link) => {
      return link.getAttribute("aria-label");
    }),
  ).toStrictEqual(["View run logs", TRACE_LABEL]);
  expect(screen.getAllByLabelText(TRACE_LABEL)).toHaveLength(1);
  expect(screen.getByText("Untraced response")).toBeInTheDocument();
});

test("Keep older API responses usable and reveal a trace after a thread update", async () => {
  const events = completedConversation("Finished response");
  installCapabilityChat({ events });
  const detail: { langfuseTraceUrls?: Record<string, string> } = {};
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
      ...detail,
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.LangfuseTrace]: true },
  });
  await readyChat();
  await expect(
    screen.findByText("Finished response"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByLabelText("Copy message").length).toBeGreaterThan(0);
  expect(screen.queryByLabelText(TRACE_LABEL)).not.toBeInTheDocument();

  const nextTraceUrl = `https://langfuse.example/trace/${SECOND_CAPABILITY_RUN_ID.replaceAll("-", "")}`;
  detail.langfuseTraceUrls = { [SECOND_CAPABILITY_RUN_ID]: nextTraceUrl };
  events.push(
    ...completedConversation("Finished response", "New traced response").slice(
      2,
    ),
  );
  publishRunUpdate();

  await expect(
    screen.findByText("New traced response"),
  ).resolves.toBeInTheDocument();
  const trace = await screen.findByLabelText(TRACE_LABEL);
  expect(trace).toHaveAttribute("href", nextTraceUrl);
  expect(screen.queryByLabelText("View run logs")).not.toBeInTheDocument();
});
