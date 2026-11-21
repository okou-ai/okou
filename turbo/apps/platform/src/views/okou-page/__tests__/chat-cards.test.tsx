import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { runConnectorAccountsContract } from "@okouai/api-contracts/contracts/run-connector-accounts";
import { mockAuthorizationCallbackThread } from "./authorization-callback-test-helpers.ts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";

import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { bankingWorkspaceContract } from "@okouai/api-contracts/contracts/banking";
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
  "/connectors/permissions?orgId=org_default&userId=test-user-123&connectorSlug=slack&permission=files:read";
const github = "/connectors/github/authorize?threadId=" + RUN_THREAD_ID;
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
  expect(earlier.compareDocumentPosition(later)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
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
  follows(sentence!, card);
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
  expect(link.closest("p")).toHaveTextContent("审批：，详见发布说明。");
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
test("Escaped and heading-like labels remain literal across valid and mismatched thread actions", async () => {
  const mismatch = github.replace(
    RUN_THREAD_ID,
    "82000000-0000-4000-8000-000000000019",
  );
  await open(
    String.raw`Read [Review \[patch\]](` +
      github +
      ") now.\n\nChoose [# Other chat](" +
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
    "# Other chat",
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
  expect(
    screen.getByText("text_" + permit, { exact: false }),
  ).toHaveTextContent("text_" + permit);
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
test("The workspace banking card identifies its purpose and read-only data scope", async () => {
  const reason = "Reconcile the October statements";
  const path =
    "/banking/access?" +
    new URLSearchParams({
      reason,
      threadId: RUN_THREAD_ID,
      callbackPrompt: "Resume reconciliation",
    }).toString();
  context.mocks.api(
    bankingWorkspaceContract.accessRequestStatus,
    ({ respond }) => {
      return respond(200, {
        agent: { id: AGENT_ID, name: "Finance Assistant" },
        connection: null,
        session: null,
        grant: null,
      });
    },
  );
  await open(origin + path);
  const card = within(await screen.findByTestId("banking-action-card"));

  expect(card.getByText(reason)).toBeInTheDocument();
  expect(
    card.getByText(/accounts, balances, and transactions · read only/i),
  ).toBeInTheDocument();
  expect(targets(origin + path)).toStrictEqual([]);
});

test("A member can review standalone Slack access while a link for another chat is unavailable", async () => {
  const link = new URL("/connectors/permissions", origin);
  link.search = new URLSearchParams({
    orgId: "org_default",
    userId: "test-user-123",
    connectorSlug: "slack",
    permission: "files:read",
  }).toString();
  const elsewhere = new URL(link);
  elsewhere.searchParams.set("threadId", crypto.randomUUID());
  elsewhere.searchParams.set("callbackPrompt", "Resume the other conversation");
  await open(
    "[Review Slack access](" +
      link.href +
      ") then [Resume elsewhere](" +
      elsewhere.href +
      ").",
  );
  await permission();
  await expect(
    screen.findByTestId("unavailable-action-card"),
  ).resolves.toBeVisible();
});

function approvalPath(
  pathname: string,
  prompt: string,
  extra: Record<string, string> = {},
) {
  return (
    pathname +
    "?" +
    new URLSearchParams({
      threadId: RUN_THREAD_ID,
      callbackPrompt: prompt,
      ...extra,
    })
  );
}

test("A standalone workspace bank review names the requested purpose and its read-only scope", async () => {
  const reason = "Prepare the refund ledger";
  mockAuthorizationCallbackThread(context, RUN_THREAD_ID);
  context.mocks.api(
    bankingWorkspaceContract.accessRequestStatus,
    ({ respond }) => {
      return respond(200, {
        agent: { id: AGENT_ID, name: "Okou" },
        grant: null,
        connection: null,
        session: null,
      });
    },
  );
  const path = approvalPath("/banking/access", "Finish the refund review", {
    reason,
  });
  await setupPage({ context, host: "app.okou.ai", path });
  const card = await screen.findByTestId("banking-action-card");
  await expect(within(card).findByText(reason)).resolves.toBeVisible();
  expect(card).toHaveTextContent(reason);
  expect(card).toHaveTextContent(
    /accounts, balances, and transactions · read only/i,
  );
  expect(location.pathname).toBe("/banking/access");
  expect(
    screen.queryByRole("region", { name: "Chat thread" }),
  ).not.toBeInTheDocument();
});

test.each(["conversation", "standalone"] as const)(
  "A member confirms the GitHub account from the %s approval link",
  async (entry) => {
    const account = {
      ...workAccount(),
      displayName: "Release team",
      connectionStatus: "connected" as const,
    };
    const callback = "Continue the release audit using the team account";
    const path = approvalPath(
      "/connectors/accounts/" + account.id + "/select",
      callback,
      { kind: "builtin", connectorSlug: "github" },
    );
    let selected: string | null = null;
    context.mocks.api(
      connectorAccountsContract.connection,
      ({ params, respond }) => {
        expect(params.connectionId).toBe(account.id);
        return respond(200, account);
      },
    );
    context.mocks.api(
      chatConnectorAccessContract.getThread,
      ({ params, respond }) => {
        expect(params.threadId).toBe(RUN_THREAD_ID);
        return respond(200, {
          target: account.target,
          currentConnectionId: selected,
          available: true,
          accounts: [
            {
              connectionId: account.id,
              displayName: account.displayName,
              defaultEnabled: true,
              isDefault: false,
              overrideEnabled: null,
              enabled: true,
            },
          ],
        });
      },
    );
    context.mocks.api(
      runConnectorAccountsContract.approve,
      ({ params, body, respond }) => {
        expect(params.threadId).toBe(RUN_THREAD_ID);
        expect(body).toMatchObject({
          connectionId: account.id,
          target: account.target,
        });
        selected = body.connectionId;
        return respond(200, body);
      },
    );
    if (entry === "conversation") {
      await open(origin + path);
    } else {
      mockAuthorizationCallbackThread(context, RUN_THREAD_ID);
      await setupPage({ context, host: "app.okou.ai", path });
    }
    const card = await screen.findByTestId("connector-account-action-card");
    const chat = screen.queryByRole("region", { name: "Chat thread" });
    expect(chat !== null).toBe(entry === "conversation");
    await expect(
      within(card).findByText("Switch to Release team?"),
    ).resolves.toBeVisible();
    const githubIcon = 'img[src="https://icons.example.test/github.svg"]';
    await waitFor(() => {
      expect(card.querySelector(githubIcon)).toBeInTheDocument();
    });
    expect(selected).toBeNull();
    const sent = context.mocks.deferred<string>();
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      expect(body.threadId).toBe(RUN_THREAD_ID);
      if (typeof body.prompt === "string" && !sent.settled()) {
        sent.resolve(body.prompt);
      }
      return respond(201, { threadId: RUN_THREAD_ID });
    });
    click(await findEnabledButton("Switch", card));
    await expect(sent.promise).resolves.toBe(callback);
    await expect(
      within(card).findByText("Switched to Release team"),
    ).resolves.toBeVisible();
    expect(selected).toBe(account.id);
    expect(card.querySelector(githubIcon)).toBeInTheDocument();
  },
);

test.each([
  ["banking", "/banking/access", { reason: "Review the renewal" }],
  [
    "connector account",
    "/connectors/accounts/" + workId + "/select",
    { kind: "builtin", connectorSlug: "github" },
  ],
] as const)(
  "The standalone %s review shows the missing page for an inaccessible chat",
  async (_kind, pathname, options) => {
    mockAuthorizationCallbackThread(context, RUN_THREAD_ID, () => {
      return false;
    });
    await setupPage({
      context,
      host: "app.okou.ai",
      path: approvalPath(pathname, "Continue the renewal", options),
    });
    await expect(
      screen.findByRole("heading", { name: "That page isn't here." }),
    ).resolves.toBeVisible();
    expect(
      screen.queryByTestId("connector-account-action-card"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("banking-action-card")).not.toBeInTheDocument();
  },
);
