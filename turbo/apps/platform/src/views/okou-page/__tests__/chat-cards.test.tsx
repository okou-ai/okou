import { screen, waitFor } from "@testing-library/react";
import { bankingUserContract } from "@okouai/api-contracts/contracts/banking";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();
const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "b0000000-0000-4000-a000-000000000902";
const CONNECTOR_URL = `https://app.okou.ai/connectors/github/authorize?agentId=${AGENT_ID}`;

function assistantMessage(id: string, content: string) {
  return {
    id,
    role: "assistant" as const,
    content,
    runId: `run-${id}`,
    createdAt: "2026-08-01T12:00:00.000Z",
  };
}

function setupChat(content: string): Promise<void> {
  mockChatLifecycle(context, {
    threadId: THREAD_ID,
    threadTitle: "Action requests",
    chatEvents: [assistantMessage("action-request", content)],
  });
  return setupPage({
    context,
    path: `/chats/${THREAD_ID}`,
    host: "app.okou.ai",
  });
}

function expectNodeBefore(before: Node, after: Node): void {
  expect(
    before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

test("A connector link becomes an action without losing surrounding prose", async () => {
  await setupChat(
    [
      "Authorization choices",
      "",
      `[Authorize GitHub](${CONNECTOR_URL})`,
      "",
      `Please approve [GitHub access](${CONNECTOR_URL}) so I can continue.`,
    ].join("\n"),
  );

  const loadedMessage = await screen.findByText("Authorization choices");
  await waitFor(() => {
    expect(screen.getAllByTestId("connector-action-card")).toHaveLength(2);
  });
  const cards = screen.getAllByTestId("connector-action-card");
  const sentence = screen.getByText(
    "Please approve GitHub access so I can continue.",
  );
  expect(cards[0]).toHaveTextContent("GitHub");
  expect(cards[1]).toHaveTextContent("GitHub");
  expect(screen.queryByText("Authorize GitHub")).toBeNull();
  expectNodeBefore(loadedMessage, cards[0]!);
  expectNodeBefore(cards[0]!, sentence);
  expectNodeBefore(sentence, cards[1]!);
});

test("Incomplete action links are shown as unavailable", async () => {
  const connectorWithoutAgent =
    "https://app.okou.ai/connectors/github/authorize";
  const bankingWithoutReason = new URL(
    `https://app.okou.ai/agents/${AGENT_ID}/banking`,
  );
  bankingWithoutReason.searchParams.set("threadId", THREAD_ID);
  bankingWithoutReason.searchParams.set(
    "callbackPrompt",
    "Continue after banking access",
  );
  await setupChat(
    [
      "Incomplete requests",
      "",
      connectorWithoutAgent,
      "",
      bankingWithoutReason.toString(),
    ].join("\n"),
  );

  await screen.findByText("Incomplete requests");
  await waitFor(() => {
    expect(screen.getAllByTestId("unavailable-action-card")).toHaveLength(2);
  });
  expect(screen.getAllByText("Action unavailable")).toHaveLength(2);
  expect(
    queryAllByRoleFast("link").some((link) => {
      return (
        link.getAttribute("href") === connectorWithoutAgent ||
        link.getAttribute("href") === bankingWithoutReason.toString()
      );
    }),
  ).toBeFalsy();
});

test("Keep the connector slot when delayed metadata is unavailable", async () => {
  const gate = context.mocks.deferred<void>();
  context.mocks.api(
    connectorCatalogContract.get,
    async ({ respond, withSignal }) => {
      await withSignal(gate.promise);
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Connector unavailable" },
      });
    },
  );
  await setupChat(
    `Authorization request\n\n${CONNECTOR_URL}\n\nAfter the request`,
  );
  const loading = await screen.findByTestId("connector-action-card-loading");
  const frame = screen.getByTestId("connector-action-card-shell");
  expect(frame).toContainElement(loading);
  gate.resolve();
  const unavailable = await screen.findByTestId("unavailable-action-card");
  expect(unavailable).toHaveTextContent("Action unavailable");
  expect(screen.getByTestId("connector-action-card-shell")).toBe(frame);
  expect(frame).toContainElement(unavailable);
  expectNodeBefore(frame, screen.getByText("After the request"));
});

test("Ordinary or code links remain message content", async () => {
  const ordinaryUrl = "https://example.com/reference";
  await setupChat(
    [
      "Reference examples",
      "",
      "```text",
      CONNECTOR_URL,
      "```",
      "",
      `Read the [ordinary reference](${ordinaryUrl}) for details.`,
    ].join("\n"),
  );

  await screen.findByText("Reference examples");
  const code = await screen.findByText(CONNECTOR_URL);
  const ordinaryLink = queryAllByRoleFast("link").find((link) => {
    return link.textContent === "ordinary reference";
  });
  expect(code.closest("code")).not.toBeNull();
  expect(ordinaryLink).toHaveAttribute("href", ordinaryUrl);
  expect(document.querySelector("[data-testid$='action-card']")).toBeNull();
});

test("A valid banking request becomes an action card", async () => {
  const reason = "Review quarterly subscription expenses";
  const bankingUrl = new URL(`https://app.okou.ai/agents/${AGENT_ID}/banking`);
  bankingUrl.searchParams.set("reason", reason);
  bankingUrl.searchParams.set("threadId", THREAD_ID);
  bankingUrl.searchParams.set(
    "callbackPrompt",
    "Continue with the subscription review",
  );
  context.mocks.api(
    bankingUserContract.accessRequestStatus,
    ({ params, respond }) => {
      expect(params.agentId).toBe(AGENT_ID);
      return respond(200, {
        agent: { id: AGENT_ID, name: "Finance Assistant" },
        connection: null,
        session: null,
        grant: null,
      });
    },
  );
  await setupChat(["Banking request", "", bankingUrl.toString()].join("\n"));

  await screen.findByText("Banking request");
  const card = await screen.findByTestId("banking-action-card");
  expect(card).toHaveTextContent("Banking access request");
  expect(card).toHaveTextContent("Finance Assistant");
  expect(card).toHaveTextContent(reason);
  expect(card).toHaveTextContent(
    "Accounts, balances, and transactions · read only",
  );
  expect(
    queryAllByRoleFast("link").some((link) => {
      return link.getAttribute("href") === bankingUrl.toString();
    }),
  ).toBeFalsy();
});
