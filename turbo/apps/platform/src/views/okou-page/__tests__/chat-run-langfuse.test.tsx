import { runsByIdContract } from "@okouai/api-contracts/contracts/run-routes";
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

const TRACE_URL = `https://langfuse.example/project/project-debug/traces/${FIRST_CAPABILITY_RUN_ID.replaceAll("-", "")}`;
const TRACE_LABEL = "View Langfuse trace";
const RUN_DETAIL = Object.freeze({
  status: "completed" as const,
  prompt: "Prepare the response",
  appendSystemPrompt: null,
  createdAt: "2026-03-10T00:00:00Z",
});

test("Link only the traced run beside Activity even after tracing is switched off", async () => {
  installCapabilityChat({
    events: completedConversation("Traced response", "Untraced response"),
  });
  context.mocks.api(runsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      ...RUN_DETAIL,
      runId: params.id,
      ...(params.id === FIRST_CAPABILITY_RUN_ID
        ? { langfuseTraceUrl: TRACE_URL }
        : {}),
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

test("Keep an untraced response usable and link the next traced run", async () => {
  const events = completedConversation("Finished response");
  installCapabilityChat({ events });
  const nextTraceUrl = `https://langfuse.example/project/project-debug/traces/${SECOND_CAPABILITY_RUN_ID.replaceAll("-", "")}`;
  context.mocks.api(runsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      ...RUN_DETAIL,
      runId: params.id,
      ...(params.id === SECOND_CAPABILITY_RUN_ID
        ? { langfuseTraceUrl: nextTraceUrl }
        : {}),
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: true,
      [FeatureSwitchKey.LangfuseTrace]: true,
    },
  });
  await readyChat();
  await expect(
    screen.findByText("Finished response"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByLabelText("Copy message").length).toBeGreaterThan(0);
  expect(screen.queryByLabelText(TRACE_LABEL)).not.toBeInTheDocument();

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
  expect(screen.getByText("Finished response")).toBeInTheDocument();
  expect(screen.getAllByLabelText(TRACE_LABEL)).toHaveLength(1);
});

test("Hide tracing actions outside debug mode", async () => {
  installCapabilityChat({ events: completedConversation("Ordinary response") });
  context.mocks.api(runsByIdContract.getById, ({ params, respond }) => {
    return respond(200, {
      ...RUN_DETAIL,
      runId: params.id,
      langfuseTraceUrl: TRACE_URL,
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: {
      [FeatureSwitchKey.OkouDebug]: false,
      [FeatureSwitchKey.LangfuseTrace]: true,
    },
  });
  await readyChat();

  await expect(
    screen.findByText("Ordinary response"),
  ).resolves.toBeInTheDocument();
  expect(screen.getAllByLabelText("Copy message").length).toBeGreaterThan(0);
  expect(screen.queryByLabelText(TRACE_LABEL)).not.toBeInTheDocument();
  expect(screen.queryByLabelText("View run logs")).not.toBeInTheDocument();
});

test("Keep the response and Activity usable while run details are loading", async () => {
  installCapabilityChat({
    events: completedConversation("Available response"),
  });
  const responseGate = context.mocks.deferred<void>();
  context.mocks.api(runsByIdContract.getById, async ({ params, respond }) => {
    await responseGate.promise;
    return respond(200, {
      ...RUN_DETAIL,
      runId: params.id,
      langfuseTraceUrl: TRACE_URL,
    });
  });

  await setupPage({
    context,
    path: RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
  });
  await readyChat();

  await expect(
    screen.findByText("Available response"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("View run logs")).toHaveAttribute(
    "href",
    `/activities/${FIRST_CAPABILITY_RUN_ID}`,
  );
  expect(screen.getAllByLabelText("Copy message").length).toBeGreaterThan(0);
  expect(screen.queryByLabelText(TRACE_LABEL)).not.toBeInTheDocument();

  responseGate.resolve(undefined);
  await expect(screen.findByLabelText(TRACE_LABEL)).resolves.toHaveAttribute(
    "href",
    TRACE_URL,
  );
});
