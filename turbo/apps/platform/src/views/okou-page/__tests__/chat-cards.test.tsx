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
const PERMISSION_URL = `https://app.okou.ai/agents/${AGENT_ID}/permissions?connectorSlug=slack&permission=files:read`;

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

test("A permission request beside an ordinary link keeps its explanation", async () => {
  const referenceUrl = "https://example.com/reference?topic=access";
  await setupChat(
    `Read the [reference](${referenceUrl}), then [allow file reads](${PERMISSION_URL}) so I can continue.`,
  );

  const card = await screen.findByTestId("permission-action-card");
  const reference = queryAllByRoleFast("link").find((link) => {
    return link.textContent === "reference";
  });
  expect(reference).toHaveAttribute("href", referenceUrl);
  const sentence = reference?.closest("p");
  expect(sentence).toHaveTextContent(
    "Read the reference, then allow file reads so I can continue.",
  );
  expectNodeBefore(sentence!, card);
  await waitFor(() => {
    expect(
      queryAllByRoleFast("button", card).find((button) => {
        return button.textContent?.trim() === "Confirm";
      }),
    ).toBeEnabled();
  });
  expect(
    queryAllByRoleFast("link").some((link) => {
      return link.getAttribute("href") === PERMISSION_URL;
    }),
  ).toBeFalsy();
});

test("Multiple actions on one line keep their order and formatted prose", async () => {
  await setupChat(
    `Please **[connect GitHub](${CONNECTOR_URL}) and [allow file reads](${PERMISSION_URL})**, then review [GitHub again](${CONNECTOR_URL}).`,
  );

  const permission = await screen.findByTestId("permission-action-card");
  await waitFor(() => {
    expect(screen.getAllByTestId("connector-action-card")).toHaveLength(2);
  });
  const connectors = screen.getAllByTestId("connector-action-card");
  const emphasis = screen.getByText("connect GitHub and allow file reads");
  expect(emphasis.tagName).toBe("STRONG");
  expect(emphasis.closest("p")).toHaveTextContent(
    "Please connect GitHub and allow file reads, then review GitHub again.",
  );
  expectNodeBefore(emphasis, connectors[0]!);
  expectNodeBefore(connectors[0]!, permission);
  expectNodeBefore(permission, connectors[1]!);
});

test("Removing formatted bare actions leaves readable prose without empty markers", async () => {
  await setupChat(
    [
      `Before **${CONNECTOR_URL}** and __${PERMISSION_URL}__, continue.`,
      "",
      `Review **${CONNECTOR_URL} and ${PERMISSION_URL}** before continuing.`,
    ].join("\n"),
  );

  await waitFor(() => {
    expect(screen.getAllByTestId("connector-action-card")).toHaveLength(2);
    expect(screen.getAllByTestId("permission-action-card")).toHaveLength(2);
  });
  expect(screen.getByText("Before and , continue.")).toBeInTheDocument();
  const emphasis = screen.getByText("and", { selector: "strong" });
  expect(emphasis.closest("p")).toHaveTextContent(
    "Review and before continuing.",
  );
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

test("Invalid actions remain unavailable beside valid and external links", async () => {
  const wrongAgentUrl = CONNECTOR_URL.replace(
    AGENT_ID,
    "c0000000-0000-4000-a000-000000000099",
  );
  const wrongThreadUrl = `${PERMISSION_URL}&threadId=b0000000-0000-4000-a000-000000000099&callbackPrompt=Continue`;
  const externalUrl = CONNECTOR_URL.replace(
    "app.okou.ai",
    "app.okou.ai.evil.test",
  );
  await setupChat(
    `Review [another agent (${wrongAgentUrl})](${wrongAgentUrl}), ${wrongThreadUrl}, [this agent](${CONNECTOR_URL}) and the [external reference](${externalUrl}).`,
  );

  await screen.findByTestId("connector-action-card");
  await waitFor(() => {
    expect(screen.getAllByTestId("unavailable-action-card")).toHaveLength(2);
  });
  const links = queryAllByRoleFast("link");
  const external = links.find((link) => {
    return link.textContent === "external reference";
  });
  expect(external).toHaveAttribute("href", externalUrl);
  expect(external?.closest("p")).toHaveTextContent(
    `Review another agent (${wrongAgentUrl}), , this agent and the external reference.`,
  );
  expect(
    links.some((link) => {
      return [wrongAgentUrl, wrongThreadUrl, CONNECTOR_URL].includes(
        link.getAttribute("href") ?? "",
      );
    }),
  ).toBeFalsy();
});

test("A bare relative permission beside another link keeps punctuation and prose", async () => {
  const relativeUrl =
    new URL(PERMISSION_URL).pathname + new URL(PERMISSION_URL).search;
  await setupChat(
    `Please authorize ${relativeUrl}。 Then read [the reference](https://example.com).`,
  );

  const card = await screen.findByTestId("permission-action-card");
  const reference = queryAllByRoleFast("link").find((link) => {
    return link.textContent === "the reference";
  });
  expect(reference).toHaveAttribute("href", "https://example.com");
  expect(reference?.closest("p")).toHaveTextContent(
    "Please authorize 。 Then read the reference.",
  );
  expectNodeBefore(reference!, card);
});

test("A bare action stops before adjacent Chinese punctuation and prose", async () => {
  await setupChat(`Please connect ${CONNECTOR_URL}。然后继续查看说明。`);

  const sentence = await screen.findByText(
    "Please connect 。然后继续查看说明。",
  );
  const card = await screen.findByTestId("connector-action-card");
  expectNodeBefore(sentence, card);
  expect(screen.queryByTestId("unavailable-action-card")).toBeNull();
});

test("Action labels stay literal instead of becoming new Markdown links or headings", async () => {
  const wrongAgentUrl = CONNECTOR_URL.replace(
    AGENT_ID,
    "c0000000-0000-4000-a000-000000000099",
  );
  await setupChat(
    [
      `[\\[reference\\]](${wrongAgentUrl}) remains literal.`,
      "",
      `[# Review](${CONNECTOR_URL}) before continuing.`,
      "",
      `[www.example.com](${wrongAgentUrl}) stays unavailable.`,
      "",
      "[reference]: https://example.com/reference",
    ].join("\n"),
  );

  await screen.findByTestId("connector-action-card");
  expect(screen.getAllByTestId("unavailable-action-card")).toHaveLength(2);
  expect(screen.getByText("[reference] remains literal.")).toBeInTheDocument();
  expect(screen.getByText("# Review before continuing.").tagName).toBe("P");
  expect(
    screen.getByText("www.example.com stays unavailable."),
  ).toBeInTheDocument();
  expect(
    queryAllByRoleFast("link").filter((link) => {
      return (
        link.getAttribute("href")?.startsWith("https://example.com") ||
        link.getAttribute("href") === "http://www.example.com"
      );
    }),
  ).toHaveLength(0);
});

test("Code, images and table links stay content beside real actions", async () => {
  await setupChat(
    [
      "Action examples",
      "",
      "```text",
      `${CONNECTOR_URL} ${PERMISSION_URL}`,
      "```",
      "",
      `Keep \`[code link](${PERMISSION_URL})\` and [connect GitHub](${CONNECTOR_URL}).`,
      "",
      `Embedded token: prefix${PERMISSION_URL}`,
      "",
      `    ${PERMISSION_URL}`,
      "",
      `![Example image](${PERMISSION_URL})`,
      "",
      "| Connector | Permission |",
      "| --- | --- |",
      `| [Table connector](${CONNECTOR_URL}) | [Table permission](${PERMISSION_URL}) |`,
    ].join("\n"),
  );

  await screen.findByTestId("connector-action-card");
  const code = screen.getByText(`[code link](${PERMISSION_URL})`);
  expect(code.closest("code")).not.toBeNull();
  expect(code.closest("p")).toHaveTextContent("and connect GitHub.");
  const tablePermission = queryAllByRoleFast("link").find((link) => {
    return link.textContent === "Table permission";
  });
  expect(tablePermission).toHaveAttribute("href", PERMISSION_URL);
  expect(tablePermission?.closest("table")).not.toBeNull();
  expect(screen.getByAltText("Example image")).toHaveAttribute(
    "src",
    PERMISSION_URL,
  );
  expect(screen.getAllByTestId("connector-action-card")).toHaveLength(1);
  expect(screen.queryByTestId("permission-action-card")).toBeNull();
});

test("Nested list actions remain available while indented code stays content", async () => {
  await setupChat(
    [
      "- Connection choices",
      `    - Please [connect GitHub](${CONNECTOR_URL}).`,
      `    - Please [allow file reads](${PERMISSION_URL}).`,
      "",
      "> Quoted example",
      ">",
      `>     ${CONNECTOR_URL}`,
      "",
      `    ${PERMISSION_URL}`,
      "",
      "- Nested code example",
      "    - Copy this example:",
      "",
      `          ${CONNECTOR_URL}`,
    ].join("\n"),
  );

  await screen.findByTestId("permission-action-card");
  expect(screen.getAllByTestId("connector-action-card")).toHaveLength(1);
  expect(screen.getAllByTestId("permission-action-card")).toHaveLength(1);
  expect(screen.getByText("Please connect GitHub.")).toBeInTheDocument();
  expect(
    screen.getByText("Please allow file reads.").closest("li"),
  ).not.toBeNull();
  const codeExamples = Array.from(
    document.querySelectorAll("pre code"),
    (code) => {
      return code.textContent?.trim();
    },
  );
  expect(codeExamples).toStrictEqual([
    CONNECTOR_URL,
    PERMISSION_URL,
    CONNECTOR_URL,
  ]);
});

test("Indented code keeps its formatting at message and action boundaries", async () => {
  await setupChat(
    [
      `    ${PERMISSION_URL}`,
      "",
      `Please [connect GitHub](${CONNECTOR_URL}).`,
      "",
      `    ${CONNECTOR_URL}`,
    ].join("\n"),
  );

  await screen.findByText("Please connect GitHub.");
  expect(screen.getAllByTestId("connector-action-card")).toHaveLength(1);
  expect(screen.queryByTestId("permission-action-card")).toBeNull();
  const codeExamples = Array.from(
    document.querySelectorAll("pre code"),
    (code) => {
      return code.textContent?.trim();
    },
  );
  expect(codeExamples).toStrictEqual([PERMISSION_URL, CONNECTOR_URL]);
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
  expectNodeBefore(loading, screen.getByText("After the request"));
  gate.resolve();
  const unavailable = await screen.findByTestId("unavailable-action-card");
  expect(unavailable).toHaveTextContent("Action unavailable");
  expectNodeBefore(unavailable, screen.getByText("After the request"));
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
