import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";

import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { bankingUserContract } from "@okouai/api-contracts/contracts/banking";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
  findEnabledButton,
  findLink,
  queryButton,
  RUN_THREAD_ID,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const permit =
  "/agents/" +
  AGENT_ID +
  "/permissions?connectorSlug=slack&permission=files:read";
const github = "/connectors/github/authorize?agentId=" + AGENT_ID;
const origin = "https://app.okou.ai";
const ref = "https://handbook.example/references";
const ticks = String.fromCharCode(96);
async function open(text: string) {
  const runId = crypto.randomUUID();
  createChatRunFixtures(context).installRunChat({
    threadId: RUN_THREAD_ID,
    chatEvents: [
      assistantEvent({ id: "review-copy", runId, seqId: 1, text }),
      completedEvent({ id: "review-done", runId, seqId: 2 }),
    ],
  });
  await setupPage({ context, path: RUN_PATH, host: "app.okou.ai" });
}
function follows(earlier: Element, later: Element) {
  expect(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}
async function permission() {
  const card = await screen.findByTestId("permission-action-card");
  expect(card).toHaveTextContent(/slack/i);
  expect(card).toHaveTextContent(/files:read|shared files/i);
  return card;
}
async function githubCard() {
  const card = await screen.findByTestId("connector-action-card");
  expect(within(card).getByText("GitHub")).toBeInTheDocument();
  return card;
}
function targets(url: string) {
  return queryAllByRoleFast("link").filter((link) => {
    return link.getAttribute("href") === url;
  });
}

test("chat-cards-002 a reference sentence remains readable above its actionable Slack request", async () => {
  await open(
    "Consult the [release manual](" +
      ref +
      ") before sharing.\n\n[Allow access](" +
      permit +
      ")",
  );
  const card = await permission();
  const link = await findLink("release manual");
  expect(link).toHaveAttribute("href", ref);
  const sentence = link.closest("p");
  expect(sentence).toHaveTextContent(
    "Consult the release manual before sharing.",
  );
  follows(link, card);
  await waitFor(() => {
    expect(queryButton("Confirm", card)).toBeEnabled();
  });
});
test("chat-cards-003 formatted action labels keep their emphasis and cards follow the message order", async () => {
  await open(
    "**Review [the patch](" +
      github +
      ") then [the attachments](" +
      permit +
      ").**\n\n[Authorize again](" +
      github +
      ")",
  );
  const slack = await permission();
  await waitFor(() => {
    expect(screen.getAllByTestId("connector-action-card")).toHaveLength(2);
  });
  const [first, last] = screen.getAllByTestId("connector-action-card");
  expect(first).toHaveTextContent("GitHub");
  expect(last).toHaveTextContent("GitHub");
  expect(
    screen.getByText(/Review the patch then the attachments/, {
      selector: "strong",
    }),
  ).toBeInTheDocument();
  follows(first!, slack);
  follows(slack, last!);
});
test("chat-cards-007 Chinese punctuation and a reference preceding a relative permission card stay in the sentence", async () => {
  await open("审批：" + permit + "，详见[发布说明](" + ref + ")。");
  const card = await permission();
  const link = await findLink("发布说明");
  expect(link).toHaveAttribute("href", ref);
  expect(link.closest("p")).toHaveTextContent("，详见发布说明。");
  follows(link, card);
});
test("chat-cards-009 embedded permission paths stay literal and an external redirect remains navigable", async () => {
  const fragments = [
    "word" + permit,
    "record_" + permit,
    "/archive" + permit,
    "next=" + permit,
    "mail@domain" + permit,
  ];
  const destination =
    "https://redirect.example/?next=" + encodeURIComponent(permit);
  await open(
    fragments.join(" ") + " [External destination](" + destination + ")",
  );
  const link = await findLink("External destination");
  expect(link).toHaveAttribute("href", destination);
  for (const fragment of fragments) {
    expect(link.closest("p")).toHaveTextContent(fragment);
  }
  expect(
    screen.queryByTestId("permission-action-card"),
  ).not.toBeInTheDocument();
});
test("chat-cards-010 a bare GitHub action leaves the Chinese continuation in the transcript", async () => {
  await open(origin + github + "，完成后继续核对。");
  await githubCard();
  expect(screen.getByText(/，完成后继续核对。/)).toBeInTheDocument();
  expect(
    screen.queryByTestId("unavailable-action-card"),
  ).not.toBeInTheDocument();
});
test("chat-cards-011 escaped and heading-like labels remain literal across valid and mismatched actions", async () => {
  const mismatch = github.replace(
    AGENT_ID,
    "82000000-0000-4000-8000-000000000019",
  );
  await open(
    String.raw`Read [Review \[patch\]](` +
      github +
      ") now.\n\nChoose [# Other agent](" +
      mismatch +
      ") later.\n\nSee [www.portal.example][other]\n\n[other]: " +
      mismatch +
      "\n\n[patch]: " +
      ref,
  );
  await githubCard();
  await waitFor(() => {
    expect(screen.getAllByTestId("unavailable-action-card")).toHaveLength(2);
  });
  expect(targets(ref)).toHaveLength(0);
  for (const label of [
    "Review [patch]",
    "# Other agent",
    "www.portal.example",
  ]) {
    expect(
      screen.getByText((_, el) => {
        return el?.tagName === "P" && el.textContent?.includes(label) === true;
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(label, { selector: "a,h1,h2,h3,h4,h5,h6" }),
    ).not.toBeInTheDocument();
  }
});
test("chat-cards-012 examples, an image and table links stay content alongside one live GitHub card", async () => {
  const imageUrl = origin + permit;
  await open(
    [
      ticks.repeat(3),
      origin + permit,
      ticks.repeat(3),
      "",
      ticks + github + ticks + " text_" + permit,
      "",
      "    " + origin + github,
      "",
      "![Overview diagram](" + imageUrl + ")",
      "",
      "| Action | Example |",
      "| --- | --- |",
      "| [Table grant](" + permit + ") | [Table login](" + github + ") |",
      "",
      "[Continue review](" + github + ")",
    ].join("\n"),
  );
  await githubCard();
  expect(screen.getAllByTestId("connector-action-card")).toHaveLength(1);
  expect(
    screen.queryByTestId("permission-action-card"),
  ).not.toBeInTheDocument();
  const examples = screen
    .getAllByText(
      (_, el) => {
        return el?.tagName === "CODE";
      },
      { selector: "code" },
    )
    .map((el) => {
      return el.textContent?.trim();
    });
  expect(examples).toStrictEqual(
    expect.arrayContaining([origin + permit, github, origin + github]),
  );
  expect(screen.getByText(/text_\/agents\//)).toHaveTextContent(
    "text_" + permit,
  );
  expect(screen.getByAltText("Overview diagram")).toHaveAttribute(
    "src",
    imageUrl,
  );
  const links = queryAllByRoleFast("link", screen.getByRole("table"));
  expect(
    links.find((link) => {
      return link.textContent?.trim() === "Table grant";
    }),
  ).toHaveAttribute("href", permit);
  expect(
    links.find((link) => {
      return link.textContent?.trim() === "Table login";
    }),
  ).toHaveAttribute("href", github);
});
test("chat-cards-013 a GitHub action keeps its decoded hash and ampersand as label text", async () => {
  await open(
    "Please choose [&#35; Review &#38; approve](" + github + ") today.",
  );
  await githubCard();
  expect(
    screen.getByText("Please choose # Review & approve today."),
  ).toBeInTheDocument();
});
test("chat-cards-014 a multiline code span preserves both URLs beside a real permission request", async () => {
  await open(
    "Use " +
      ticks +
      origin +
      github +
      "\n" +
      ref +
      ticks +
      " for comparison.\n\n[Read the files](" +
      permit +
      ")",
  );
  await permission();
  const code = screen.getByText(/\/connectors\/github\//, { selector: "code" });
  expect(code).toHaveTextContent(origin + github + " " + ref);
  expect(screen.queryByTestId("connector-action-card")).not.toBeInTheDocument();
});
test("chat-cards-017 indented examples keep their order around one actionable paragraph", async () => {
  await open(
    "    " +
      permit +
      "\n\nReview [this connection](" +
      github +
      ").\n\n    " +
      github,
  );
  await githubCard();
  const a = screen.getByText(
    (_, el) => {
      return el?.textContent?.trim() === permit;
    },
    { selector: "pre code" },
  );
  const b = screen.getByText(
    (_, el) => {
      return el?.textContent?.trim() === github;
    },
    { selector: "pre code" },
  );
  follows(a, b);
  expect(screen.getAllByTestId("connector-action-card")).toHaveLength(1);
  expect(
    screen.queryByTestId("permission-action-card"),
  ).not.toBeInTheDocument();
});

const workId = "f0000000-0000-4000-8000-000000000022";
function workAccount(): ConnectorAccountConnection {
  return {
    id: workId,
    target: { kind: "builtin", connectorSlug: "github" },
    displayName: "Work GitHub",
    isDefault: false,
    authMethod: "oauth",
    connectionStatus: "reconnect-required",
    reconnectReason: null,
    externalId: workId,
    externalUsername: null,
    externalEmail: null,
    oauthScopes: null,
    tokenExpiresAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    missingRequiredFields: [],
    configuredFieldKeys: [],
  };
}
function reconnectRequest(id: string) {
  return (
    "/connectors/github/reconnect/" +
    id +
    "?" +
    new URLSearchParams({
      agentId: AGENT_ID,
      threadId: RUN_THREAD_ID,
      callbackPrompt: "Continue account maintenance",
    }).toString()
  );
}
function reconnectAccount() {
  const work = workAccount();
  let available = true;
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      return available && params.connectionId === work.id
        ? respond(200, work)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account removed" },
          });
    },
  );
  return {
    remove: () => {
      available = false;
    },
  };
}
async function reconnectCard() {
  const card = await screen.findByTestId("connector-action-card");
  expect(card).toHaveTextContent("GitHub · Work GitHub");
  return findEnabledButton("Reconnect", card);
}
test("chat-cards-022 the work account offers its stored OAuth method in the conversation", async () => {
  const authorization =
    "https://github.example.test/login/oauth/authorize?state=work";
  const popup = context.mocks.browser.authWindow();
  const destination = { href: "about:blank" };
  Object.defineProperty(popup, "location", { value: destination });
  context.mocks.browser.open(popup);
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ params, body, respond }) => {
      if (
        params.connectorSlug !== "github" ||
        body.authMethod !== "oauth" ||
        body.account.intent !== "reconnect" ||
        body.account.connectionId !== workId
      ) {
        throw new Error("Unexpected authorization target");
      }
      return respond(200, {
        authorizationUrl: authorization,
        oauthAttemptId: crypto.randomUUID(),
      });
    },
  );
  reconnectAccount();
  await open(origin + reconnectRequest(workId));
  click(await reconnectCard());
  const modal = await screen.findByRole("dialog");
  const dialog = within(modal);
  expect(dialog.getByText(/Work GitHub/)).toBeInTheDocument();
  const reconnect = await findEnabledButton("Reconnect", modal);
  expect(dialog.queryByText("API Token", { selector: "label" })).toBeNull();
  expect(modal.querySelector("input")).toBeNull();
  click(reconnect);
  await waitFor(() => {
    expect(destination.href).toBe(authorization);
  });
  expect(window.location.pathname).toBe(RUN_PATH);
});
test("chat-cards-025 an account removed after rendering cannot open a reconnect dialog", async () => {
  const service = reconnectAccount();
  await open(origin + reconnectRequest(workId));
  const button = await reconnectCard();
  service.remove();
  click(button);
  await screen.findByTestId("unavailable-action-card");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(window.location.pathname).toBe(RUN_PATH);
});
test("chat-cards-033 the banking card identifies the requesting agent, purpose and read-only data scope", async () => {
  const reason = "Reconcile the October statements";
  const path =
    "/agents/" +
    AGENT_ID +
    "/banking?" +
    new URLSearchParams({
      reason,
      threadId: RUN_THREAD_ID,
      callbackPrompt: "Resume reconciliation",
    }).toString();
  context.mocks.api(bankingUserContract.accessRequestStatus, ({ respond }) => {
    return respond(200, {
      agent: { id: AGENT_ID, name: "Finance Assistant" },
      connection: null,
      session: null,
      grant: null,
    });
  });
  await open(origin + path);
  const card = within(await screen.findByTestId("banking-action-card"));
  expect(card.getByText("Finance Assistant")).toBeInTheDocument();
  expect(card.getByText(reason)).toBeInTheDocument();
  expect(
    card.getByText(/accounts, balances, and transactions · read only/i),
  ).toBeInTheDocument();
  expect(targets(origin + path)).toStrictEqual([]);
});
