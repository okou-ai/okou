import {
  bankingUserContract,
  type BankingAccessRequestStatusResponse,
} from "@okouai/api-contracts/contracts/banking";
import {
  connectorAccountsContract,
  type ConnectorAccountConnection,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorCatalogContract,
  type PublicConnectorCatalogStatusItem,
} from "@okouai/api-contracts/contracts/connector-catalog";
import { chatConnectorAccessContract } from "@okouai/api-contracts/contracts/chat-connector-access";
import { builtinConnectorManualGrantContract } from "@okouai/api-contracts/contracts/connectors";
import { runConnectorAccountsContract } from "@okouai/api-contracts/contracts/run-connector-accounts";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  catalogFixture,
  connectorAccountFixture,
} from "../../../mocks/handlers/connector-account-fixtures.ts";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  CAPABILITY_AGENT_ID,
  completedConversation,
  createChatCapabilityHelpers,
  readyChat,
  RUN_PATH,
  RUN_THREAD_ID,
  type CapturedChatSend,
} from "./chat-capability-test-helpers.ts";
import {
  bankingActionUrl,
  connectorActionUrl,
  permissionActionUrl,
  permissionMetadata,
} from "./chat-capability-connector-test-helpers.ts";

const context = testContext();
const { installCapabilityChat } = createChatCapabilityHelpers(context);

const OTHER_AGENT_ID = "c0000000-0000-4000-a000-000000000099";
const SLACK_FILE_READ = "files:read";

const CARD_SELECTOR = [
  '[data-testid="connector-action-card"]',
  '[data-testid="permission-action-card"]',
  '[data-testid="unavailable-action-card"]',
  '[data-testid="banking-action-card"]',
].join(", ");
const LOADING_SELECTOR = [
  '[data-testid="connector-action-card-loading"]',
  '[data-testid="banking-action-card-loading"]',
  '[data-testid="permission-action-card"][aria-busy="true"]',
].join(", ");

function slackFileReadUrl(agentId = CAPABILITY_AGENT_ID): string {
  const url = new URL(
    permissionActionUrl({
      connectorSlug: "slack",
      permission: SLACK_FILE_READ,
    }),
  );
  url.pathname = `/agents/${agentId}/permissions`;
  return url.href;
}

function relativeSlackFileReadUrl(): string {
  const url = new URL(slackFileReadUrl());
  return `${url.pathname}${url.search}`;
}

function githubUrl(
  args: { readonly callbackPrompt?: string; readonly agentId?: string } = {},
): string {
  const url = new URL(
    connectorActionUrl({
      slug: "github",
      ...(args.callbackPrompt ? { callbackPrompt: args.callbackPrompt } : {}),
    }),
  );
  if (args.agentId) {
    url.searchParams.set("agentId", args.agentId);
  }
  return url.href;
}

function installMessage(markdown: string, sends?: CapturedChatSend[]): void {
  context.mocks.api(
    connectorCatalogContract.permissions,
    ({ params, respond }) => {
      return params.connectorSlug === "slack"
        ? respond(200, {
            permissions: permissionMetadata({
              connectorSlug: "slack",
              label: "Slack",
              permissions: [SLACK_FILE_READ],
            }),
          })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Connector not found" },
          });
    },
  );
  installCapabilityChat({
    events: completedConversation(markdown),
    onSend(send) {
      sends?.push(send);
    },
  });
}

async function openMessage(): Promise<HTMLElement> {
  await setupPage({ context, host: "app.okou.ai", path: RUN_PATH });
  await readyChat();
  return await waitFor(() => {
    const markdown = document.querySelector<HTMLElement>(
      '[data-role="assistant"] [data-slot="markdown"]',
    );
    if (!markdown) {
      throw new Error("The assistant message is not rendered");
    }
    return markdown;
  });
}

function cardToken(card: HTMLElement): string {
  switch (card.dataset.testid) {
    case "connector-action-card": {
      return `connector:${within(card).getByTestId("connector-card-label").textContent ?? ""}`;
    }
    case "permission-action-card": {
      return `permission:${within(card).getByText(/^(Allow|Deny) /u).textContent ?? ""}`;
    }
    case "banking-action-card": {
      return "banking";
    }
    default: {
      return "unavailable";
    }
  }
}

async function settledCards(
  markdown: HTMLElement,
  count: number,
): Promise<string[]> {
  return await waitFor(() => {
    expect(markdown.querySelector(LOADING_SELECTOR)).toBeNull();
    const cards = Array.from(
      markdown.querySelectorAll<HTMLElement>(CARD_SELECTOR),
    );
    expect(cards).toHaveLength(count);
    return cards.map(cardToken);
  });
}

function proseText(markdown: HTMLElement): string {
  const prose = markdown.cloneNode(true);
  if (!(prose instanceof HTMLElement)) {
    throw new Error("The message could not be copied");
  }
  for (const card of prose.querySelectorAll('[data-slot="markdown-card"]')) {
    card.remove();
  }
  return prose.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function messageLinks(
  markdown: HTMLElement,
): { readonly text: string; readonly href: string | null }[] {
  return queryAllByRoleFast("link", markdown)
    .filter((link) => {
      return !link.closest('[data-slot="markdown-card"]');
    })
    .map((link) => {
      return {
        text: link.textContent?.trim() ?? "",
        href: link.getAttribute("href"),
      };
    });
}

function getButton(name: string, container: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.replace(/\s+/gu, " ").trim() === name
    );
  });
  if (!button) {
    throw new Error(`${name} button is not available`);
  }
  return button;
}

function expectFollows(earlier: Node, later: Node): void {
  expect(
    earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

function paragraphContaining(markdown: HTMLElement, text: string): HTMLElement {
  const paragraph = Array.from(markdown.querySelectorAll("p")).find((p) => {
    return p.textContent?.includes(text);
  });
  if (!paragraph) {
    throw new Error(`No paragraph contains ${text}`);
  }
  return paragraph;
}

function emptyBankingStatus(): BankingAccessRequestStatusResponse {
  return {
    agent: { id: CAPABILITY_AGENT_ID, name: "Finance Assistant" },
    connection: null,
    session: null,
    grant: null,
  };
}

test("A permission request beside an ordinary link keeps its explanation", async () => {
  installMessage(
    `Read the [Slack file guide](https://docs.example.test/slack-files) before approving. [Allow file reads](${slackFileReadUrl()})`,
  );
  const markdown = await openMessage();

  await expect(settledCards(markdown, 1)).resolves.toStrictEqual([
    `permission:Allow ${SLACK_FILE_READ}`,
  ]);
  expect(messageLinks(markdown)).toStrictEqual([
    {
      text: "Slack file guide",
      href: "https://docs.example.test/slack-files",
    },
  ]);
  const sentence = paragraphContaining(markdown, "Slack file guide");
  expect(sentence).toHaveTextContent(
    "Read the Slack file guide before approving.",
  );
  const card = within(markdown).getByTestId("permission-action-card");
  await waitFor(() => {
    expect(getButton("Confirm", card)).toBeEnabled();
  });
  expectFollows(sentence, card);
});

test("Multiple actions on one line keep their order and formatted prose", async () => {
  installMessage(
    `**Connect [GitHub](${githubUrl({ callbackPrompt: "Review the repository" })}) and allow [file reads](${slackFileReadUrl()}) before the review**, then [connect GitHub again](${githubUrl({ callbackPrompt: "Open the pull request" })}).`,
  );
  const markdown = await openMessage();

  await expect(settledCards(markdown, 3)).resolves.toStrictEqual([
    "connector:GitHub",
    `permission:Allow ${SLACK_FILE_READ}`,
    "connector:GitHub",
  ]);
  expect(markdown.querySelector("strong")).toHaveTextContent(
    "Connect GitHub and allow file reads before the review",
  );
  expect(proseText(markdown)).toContain(
    "before the review, then connect GitHub again.",
  );
  expect(messageLinks(markdown)).toStrictEqual([]);
});

test("A bare relative permission beside another link keeps punctuation and prose", async () => {
  installMessage(
    `请允许读取文件 ${relativeSlackFileReadUrl()}，然后查看[参考文档](https://docs.example.test/reference)。`,
  );
  const markdown = await openMessage();

  await expect(settledCards(markdown, 1)).resolves.toStrictEqual([
    `permission:Allow ${SLACK_FILE_READ}`,
  ]);
  const sentence = paragraphContaining(markdown, "参考文档");
  expect(proseText(markdown)).toContain("，然后查看参考文档。");
  expect(proseText(markdown)).not.toContain("/agents/");
  expect(messageLinks(markdown)).toStrictEqual([
    { text: "参考文档", href: "https://docs.example.test/reference" },
  ]);
  expectFollows(
    sentence,
    within(markdown).getByTestId("permission-action-card"),
  );
});

test("Action-looking URLs embedded in structural text remain content", async () => {
  const absolute = slackFileReadUrl();
  const relative = relativeSlackFileReadUrl();
  const redirect = `https://redirect.example.test/out?next=${encodeURIComponent(absolute)}`;
  installMessage(
    [
      `- Word: review${relative}`,
      `- Identifier: ACTION_URL_${absolute}`,
      `- Path: ./exports${relative}`,
      `- Assignment: url=${absolute}`,
      `- Address: ops@app.okou.ai${relative}`,
      `- Redirect: [Open the redirect](${redirect})`,
    ].join("\n"),
  );
  const markdown = await openMessage();

  await waitFor(() => {
    expect(proseText(markdown)).toContain("Open the redirect");
  });
  expect(markdown.querySelector(CARD_SELECTOR)).toBeNull();
  const prose = proseText(markdown);
  expect(prose).toContain(`review${relative}`);
  expect(prose).toContain(`ACTION_URL_${absolute}`);
  expect(prose).toContain(`./exports${relative}`);
  expect(prose).toContain(`url=${absolute}`);
  expect(prose).toContain(`ops@app.okou.ai${relative}`);
  expect(messageLinks(markdown)).toContainEqual({
    text: "Open the redirect",
    href: redirect,
  });
});

test("A bare action stops before adjacent Chinese punctuation and prose", async () => {
  installMessage(`请先连接 ${githubUrl()}。完成后继续。`);
  const markdown = await openMessage();

  await expect(settledCards(markdown, 1)).resolves.toStrictEqual([
    "connector:GitHub",
  ]);
  expect(proseText(markdown)).toContain("请先连接");
  expect(proseText(markdown)).toContain("。完成后继续。");
  expect(proseText(markdown)).not.toContain("https://");
  expect(
    within(markdown).queryByTestId("unavailable-action-card"),
  ).not.toBeInTheDocument();
});

test("Action labels stay literal instead of becoming new Markdown links or headings", async () => {
  installMessage(
    [
      `[Connect \\[GitHub\\]](${githubUrl()}) then [# Grant access](${githubUrl({ agentId: OTHER_AGENT_ID })}) and [docs.example.test](${slackFileReadUrl(OTHER_AGENT_ID)}).`,
      "[GitHub]: https://github.example.test/reference",
    ].join("\n\n"),
  );
  const markdown = await openMessage();

  await expect(settledCards(markdown, 3)).resolves.toStrictEqual([
    "connector:GitHub",
    "unavailable",
    "unavailable",
  ]);
  const prose = proseText(markdown);
  expect(prose).toContain("Connect [GitHub]");
  expect(prose).toContain("# Grant access");
  expect(prose).toContain("docs.example.test");
  expect(markdown.querySelector("h1, h2, h3, h4, h5, h6")).toBeNull();
  expect(messageLinks(markdown)).toStrictEqual([]);
});

test("Code, images and table links stay content beside real actions", async () => {
  const fenced = githubUrl({ callbackPrompt: "Fenced example" });
  const inline = githubUrl({ callbackPrompt: "Inline example" });
  const embedded = githubUrl({ callbackPrompt: "Embedded example" });
  const indented = githubUrl({ callbackPrompt: "Indented example" });
  const image = githubUrl({ callbackPrompt: "Image example" });
  const tableGithub = githubUrl({ callbackPrompt: "Table example" });
  const tablePermission = slackFileReadUrl();
  installMessage(
    [
      `Connect [GitHub](${githubUrl()}) to continue.`,
      ["```text", fenced, "```"].join("\n"),
      `Inline \`${inline}\` stays code.`,
      `The token abc${embedded}xyz stays text.`,
      `    ${indented}`,
      `![GitHub authorization](${image})`,
      [
        "| Step | Link |",
        "| --- | --- |",
        `| GitHub | [Authorize](${tableGithub}) |`,
        `| Files | [Allow](${tablePermission}) |`,
      ].join("\n"),
    ].join("\n\n"),
  );
  const markdown = await openMessage();

  await expect(settledCards(markdown, 1)).resolves.toStrictEqual([
    "connector:GitHub",
  ]);
  const blocks = Array.from(markdown.querySelectorAll("pre")).map((pre) => {
    return pre.textContent?.trim();
  });
  expect(blocks).toStrictEqual([fenced, indented]);
  const inlineCode = Array.from(markdown.querySelectorAll("code")).find(
    (code) => {
      return !code.closest("pre");
    },
  );
  expect(inlineCode).toHaveTextContent(inline);
  expect(proseText(markdown)).toContain(`abc${embedded}xyz`);
  expect(
    markdown.querySelector('img[alt="GitHub authorization"]'),
  ).toBeInTheDocument();
  const table = markdown.querySelector("table");
  if (!(table instanceof HTMLElement)) {
    throw new Error("The table is not rendered");
  }
  expect(messageLinks(table)).toStrictEqual([
    { text: "Authorize", href: tableGithub },
    { text: "Allow", href: tablePermission },
  ]);
});

test("Retained action labels preserve numeric character references", async () => {
  installMessage(
    `Next step: [&#35; Review &#38; approve](${githubUrl()}) today.`,
  );
  const markdown = await openMessage();

  await expect(settledCards(markdown, 1)).resolves.toStrictEqual([
    "connector:GitHub",
  ]);
  expect(proseText(markdown)).toBe("Next step: # Review & approve today.");
});

test("Multiline inline code stays literal beside a real action", async () => {
  const github = githubUrl();
  installMessage(
    `Keep \`example ${github}\nhttps://example.test/plain\` as a literal sample. [Allow file reads](${slackFileReadUrl()})`,
  );
  const markdown = await openMessage();

  await expect(settledCards(markdown, 1)).resolves.toStrictEqual([
    `permission:Allow ${SLACK_FILE_READ}`,
  ]);
  const code = markdown.querySelector("code");
  expect(code?.textContent).toContain(github);
  expect(code?.textContent).toContain("https://example.test/plain");
  expect(
    within(markdown).queryByTestId("connector-action-card"),
  ).not.toBeInTheDocument();
});

test("Indented code keeps its formatting at message and action boundaries", async () => {
  const indentedGithub = githubUrl({ callbackPrompt: "Indented example" });
  installMessage(
    [
      `    ${relativeSlackFileReadUrl()}`,
      `Connect [GitHub](${githubUrl()}) for the review.`,
      `    ${indentedGithub}`,
    ].join("\n\n"),
  );
  const markdown = await openMessage();

  await expect(settledCards(markdown, 1)).resolves.toStrictEqual([
    "connector:GitHub",
  ]);
  expect(
    Array.from(markdown.querySelectorAll("pre")).map((pre) => {
      return pre.textContent?.trim();
    }),
  ).toStrictEqual([relativeSlackFileReadUrl(), indentedGithub]);
  expect(proseText(markdown)).toContain("Connect GitHub for the review.");
});

test("A valid banking request becomes an action card", async () => {
  const purpose = "Review recent cash-flow activity";
  context.mocks.api(bankingUserContract.accessRequestStatus, ({ respond }) => {
    return respond(200, emptyBankingStatus());
  });
  const url = bankingActionUrl({
    reason: purpose,
    callbackPrompt: "Continue the banking review",
  });
  installMessage(`Banking access is needed.\n\n${url}`);
  const markdown = await openMessage();

  await expect(settledCards(markdown, 1)).resolves.toStrictEqual(["banking"]);
  const card = within(markdown).getByTestId("banking-action-card");
  expect(within(card).getAllByText("Finance Assistant")[0]).toBeInTheDocument();
  expect(within(card).getAllByText(purpose)[0]).toBeInTheDocument();
  expect(
    within(card).getAllByText(
      "Accounts, balances, and transactions · read only",
    )[0],
  ).toBeInTheDocument();
  expect(messageLinks(markdown)).toStrictEqual([]);
  expect(proseText(markdown)).not.toContain(url);
  expect(screen.queryByRole("dialog")).toBeNull();
});

const WORK_ACCOUNT_ID = "e0000000-0000-4000-a000-000000000931";
const DEFAULT_ACCOUNT_ID = "e0000000-0000-4000-a000-000000000932";
const GITHUB_ICON = "https://icons.example.test/github.svg";

function githubCatalog(): PublicConnectorCatalogStatusItem {
  return catalogFixture({
    slug: "github",
    label: "GitHub",
    description: "GitHub repositories",
    icon: { url: GITHUB_ICON, invertInDarkMode: false },
    category: "Productivity",
    generation: [],
    tags: [],
    authMethods: [
      {
        id: "oauth",
        label: "GitHub sign-in",
        description: "Sign in with GitHub.",
        grantKind: "auth-code",
        supportsRefresh: true,
        manualFields: [],
        startOptions: [],
      },
      {
        id: "api-token",
        label: "API token",
        description: null,
        grantKind: "manual",
        supportsRefresh: false,
        manualFields: [
          {
            id: "apiToken",
            label: "API token",
            required: true,
            placeholder: "ghp_token",
            inputType: "password",
          },
        ],
        startOptions: [],
      },
    ],
    permissionSummary: {
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    },
    singleAuthCodeAuthMethodId: null,
    connectNotice: null,
  });
}

function githubAccount(
  overrides: Partial<Omit<ConnectorAccountConnection, "target">>,
): ConnectorAccountConnection {
  return connectorAccountFixture(
    { kind: "builtin", connectorSlug: "github" },
    overrides,
  );
}

function workGithub(
  overrides: Partial<Omit<ConnectorAccountConnection, "target">> = {},
): ConnectorAccountConnection {
  return githubAccount({
    id: WORK_ACCOUNT_ID,
    displayName: "Work GitHub",
    isDefault: false,
    authMethod: "api-token",
    connectionStatus: "reconnect-required",
    reconnectReason: "authorization_expired_or_revoked",
    configuredFieldKeys: ["apiToken"],
    ...overrides,
  });
}

function installGithubAccounts(
  read: () => readonly ConnectorAccountConnection[],
): void {
  const catalog = githubCatalog();
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    return params.connectorSlug === "github"
      ? respond(200, { connector: catalog })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Connector not found" },
        });
  });
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      const account = read().find((candidate) => {
        return candidate.id === params.connectionId;
      });
      return account
        ? respond(200, account)
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Account not found" },
          });
    },
  );
}

function reconnectUrl(callbackPrompt: string): string {
  const url = new URL(
    `/connectors/github/reconnect/${WORK_ACCOUNT_ID}`,
    "https://app.okou.ai",
  );
  url.searchParams.set("agentId", CAPABILITY_AGENT_ID);
  url.searchParams.set("threadId", RUN_THREAD_ID);
  url.searchParams.set("callbackPrompt", callbackPrompt);
  return url.href;
}

function sentPrompts(sends: readonly CapturedChatSend[]): string[] {
  return sends.map((send) => {
    return send.prompt;
  });
}

async function readyConnectorCard(
  markdown: HTMLElement,
  action: string,
): Promise<HTMLElement> {
  return await waitFor(() => {
    const card = within(markdown).getByTestId("connector-action-card");
    expect(getButton(action, card)).toBeEnabled();
    return card;
  });
}

async function openReconnectDialog(card: HTMLElement): Promise<HTMLElement> {
  click(getButton("Reconnect", card));
  return await screen.findByRole("dialog", { name: "GitHub · Work GitHub" });
}

test("An exact reconnect card opens the non-default account dialog and continues only after success", async () => {
  const callbackPrompt = "Continue the account-specific task";
  const sends: CapturedChatSend[] = [];
  let work = workGithub();
  installGithubAccounts(() => {
    return [
      work,
      githubAccount({ id: DEFAULT_ACCOUNT_ID, displayName: "Personal GitHub" }),
    ];
  });
  const saveStarted = context.mocks.deferred<void>();
  const releaseSave = context.mocks.deferred<void>();
  const submitted: unknown[] = [];
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    async ({ body, respond, withSignal }) => {
      submitted.push({ account: body.account, values: body.values });
      saveStarted.resolve();
      await withSignal(releaseSave.promise);
      work = workGithub({
        connectionStatus: "connected",
        reconnectReason: null,
      });
      return respond(200, { connectionId: WORK_ACCOUNT_ID });
    },
  );
  installMessage(
    `The work account needs attention. [Reconnect Work GitHub](${reconnectUrl(callbackPrompt)})`,
    sends,
  );
  const markdown = await openMessage();

  const card = await readyConnectorCard(markdown, "Reconnect");
  expect(within(card).getByTestId("connector-card-label")).toHaveTextContent(
    "GitHub · Work GitHub",
  );
  const dialog = await openReconnectDialog(card);
  expect(location.pathname).toBe(RUN_PATH);
  await fill(within(dialog).getByPlaceholderText("ghp_token"), "ghp_work");
  click(getButton("Save", dialog));
  await saveStarted.promise;
  expect(sends).toStrictEqual([]);

  releaseSave.resolve();
  await waitFor(() => {
    expect(sentPrompts(sends)).toStrictEqual([callbackPrompt]);
  });
  expect(submitted).toStrictEqual([
    {
      account: { intent: "reconnect", connectionId: WORK_ACCOUNT_ID },
      values: { apiToken: "ghp_work" },
    },
  ]);
  expect(location.pathname).toBe(RUN_PATH);
});

test("A reconnect completion for another account never continues the chat", async () => {
  const sends: CapturedChatSend[] = [];
  installGithubAccounts(() => {
    return [
      workGithub(),
      githubAccount({ id: DEFAULT_ACCOUNT_ID, displayName: "Personal GitHub" }),
    ];
  });
  const submitted: unknown[] = [];
  const responded = context.mocks.deferred<void>();
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ body, respond }) => {
      submitted.push(body.account);
      responded.resolve();
      return respond(200, { connectionId: DEFAULT_ACCOUNT_ID });
    },
  );
  installMessage(
    `[Reconnect Work GitHub](${reconnectUrl("Continue with the work account")})`,
    sends,
  );
  const markdown = await openMessage();

  const dialog = await openReconnectDialog(
    await readyConnectorCard(markdown, "Reconnect"),
  );
  await fill(within(dialog).getByPlaceholderText("ghp_token"), "ghp_work");
  click(getButton("Save", dialog));
  await responded.promise;

  await waitFor(() => {
    expect(getButton("Save", dialog)).toBeEnabled();
  });
  expect(submitted).toStrictEqual([
    { intent: "reconnect", connectionId: WORK_ACCOUNT_ID },
  ]);
  expect(dialog).toBeInTheDocument();
  expect(sends).toStrictEqual([]);
});

test("An exact OAuth account opens the in-chat dialog with only its stored auth method", async () => {
  installGithubAccounts(() => {
    return [workGithub({ authMethod: "oauth", configuredFieldKeys: [] })];
  });
  installMessage(
    `[Reconnect Work GitHub](${reconnectUrl("Continue with the work account")})`,
  );
  const markdown = await openMessage();

  const dialog = await openReconnectDialog(
    await readyConnectorCard(markdown, "Reconnect"),
  );
  expect(location.pathname).toBe(RUN_PATH);
  expect(getButton("Reconnect", dialog)).toBeEnabled();
  expect(within(dialog).queryByPlaceholderText("ghp_token")).toBeNull();
  expect(within(dialog).queryByText("API token")).toBeNull();
});

test("A bare relative exact reconnect link opens the dialog and retains its callback", async () => {
  const callbackPrompt = "Continue with Work GitHub";
  const sends: CapturedChatSend[] = [];
  let work = workGithub();
  installGithubAccounts(() => {
    return [work];
  });
  context.mocks.api(
    builtinConnectorManualGrantContract.connect,
    ({ respond }) => {
      work = workGithub({
        connectionStatus: "connected",
        reconnectReason: null,
      });
      return respond(200, { connectionId: WORK_ACCOUNT_ID });
    },
  );
  const absolute = new URL(reconnectUrl(callbackPrompt));
  installMessage(
    `请重新连接 ${absolute.pathname}${absolute.search}。完成后告诉我。`,
    sends,
  );
  const markdown = await openMessage();

  const card = await readyConnectorCard(markdown, "Reconnect");
  expect(within(card).getByTestId("connector-card-label")).toHaveTextContent(
    "GitHub · Work GitHub",
  );
  expect(proseText(markdown)).toContain("请重新连接");
  expect(proseText(markdown)).toContain("。完成后告诉我。");
  expect(proseText(markdown)).not.toContain("/connectors/");
  const dialog = await openReconnectDialog(card);
  expect(location.pathname).toBe(RUN_PATH);
  await fill(within(dialog).getByPlaceholderText("ghp_token"), "ghp_work");
  click(getButton("Save", dialog));

  await waitFor(() => {
    expect(sentPrompts(sends)).toStrictEqual([callbackPrompt]);
  });
  expect(location.pathname).toBe(RUN_PATH);
});

test("A reconnect card rechecks an account that disappears before activation", async () => {
  let accounts: ConnectorAccountConnection[] = [workGithub()];
  installGithubAccounts(() => {
    return accounts;
  });
  installMessage(
    `[Reconnect Work GitHub](${reconnectUrl("Continue with the work account")})`,
  );
  const markdown = await openMessage();
  const card = await readyConnectorCard(markdown, "Reconnect");

  accounts = [];
  click(getButton("Reconnect", card));

  await expect(
    within(markdown).findByTestId("unavailable-action-card"),
  ).resolves.toBeInTheDocument();
  expect(
    within(markdown).queryByTestId("connector-action-card"),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(location.pathname).toBe(RUN_PATH);
});

test("Connector account switches A → B → A keep their icon and continue with fresh callback IDs", async () => {
  const sends: CapturedChatSend[] = [];
  const work = githubAccount({
    id: WORK_ACCOUNT_ID,
    displayName: "Work GitHub",
    isDefault: false,
  });
  const personal = githubAccount({
    id: DEFAULT_ACCOUNT_ID,
    displayName: "Personal GitHub",
  });
  installGithubAccounts(() => {
    return [work, personal];
  });
  let current: string | null = null;
  const approvals: string[] = [];
  context.mocks.api(
    chatConnectorAccessContract.getThread,
    ({ query, respond }) => {
      return respond(200, {
        target: query,
        accounts: [work, personal].map((account) => {
          return {
            connectionId: account.id,
            displayName: account.displayName,
            defaultEnabled: true,
            isDefault: account.isDefault,
            overrideEnabled: null,
            enabled: true,
          };
        }),
        currentConnectionId: current,
        available: true,
      });
    },
  );
  context.mocks.api(
    runConnectorAccountsContract.approve,
    ({ body, respond }) => {
      approvals.push(body.connectionId);
      current = body.connectionId;
      return respond(200, body);
    },
  );
  const selectUrl = (connectionId: string, callbackPrompt: string) => {
    const url = new URL(
      `/agents/${CAPABILITY_AGENT_ID}/connector-accounts/${connectionId}/select`,
      "https://app.okou.ai",
    );
    url.searchParams.set("kind", "builtin");
    url.searchParams.set("connectorSlug", "github");
    url.searchParams.set("threadId", RUN_THREAD_ID);
    url.searchParams.set("callbackPrompt", callbackPrompt);
    return url.href;
  };
  installMessage(
    [
      `Use the work account: [Work GitHub](${selectUrl(WORK_ACCOUNT_ID, "Use Work GitHub")})`,
      `Later, use the personal account: [Personal GitHub](${selectUrl(DEFAULT_ACCOUNT_ID, "Use Personal GitHub")})`,
    ].join("\n\n"),
    sends,
  );
  const markdown = await openMessage();
  const switchCard = async (title: string): Promise<HTMLElement> => {
    return await waitFor(() => {
      const card = within(markdown)
        .getAllByTestId("connector-account-action-card")
        .find((candidate) => {
          return within(candidate).queryByText(title) !== null;
        });
      if (!card) {
        throw new Error(`${title} is not shown`);
      }
      return card;
    });
  };
  const switchTo = async (account: string, sendCount: number) => {
    const card = await switchCard(`Switch to ${account}?`);
    await waitFor(() => {
      expect(getButton("Switch", card)).toBeEnabled();
    });
    click(getButton("Switch", card));
    await switchCard(`Switched to ${account}`);
    await waitFor(() => {
      expect(sends).toHaveLength(sendCount);
    });
  };

  await switchTo("Work GitHub", 1);
  await switchTo("Personal GitHub", 2);
  await switchTo("Work GitHub", 3);

  expect(approvals).toStrictEqual([
    WORK_ACCOUNT_ID,
    DEFAULT_ACCOUNT_ID,
    WORK_ACCOUNT_ID,
  ]);
  expect(sentPrompts(sends)).toStrictEqual([
    "Use Work GitHub",
    "Use Personal GitHub",
    "Use Work GitHub",
  ]);
  expect(
    new Set(
      sends.map((send) => {
        return send.clientEventId;
      }),
    ).size,
  ).toBe(3);
  expect(
    new Set(
      sends.map((send) => {
        return send.chatThreadSortEventId;
      }),
    ).size,
  ).toBe(3);
  for (const card of within(markdown).getAllByTestId(
    "connector-account-action-card",
  )) {
    expect(card.querySelector("img")).toHaveAttribute("src", GITHUB_ICON);
  }
});
