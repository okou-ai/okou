import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { HttpResponse } from "msw";
import {
  walletUserContract,
  type WalletConnectStatus,
} from "@okouai/api-contracts/contracts/wallet";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();
const CONNECT_URL =
  "https://login.link.com/auth?key=pk_test_fixture&client_id=fixture&redirect_uri=https%3A%2F%2Fapp.okou.ai%2Fconnectors%2Flink%2Fcallback&response_type=code&scope=payment_methods.agentic&state=exact%2Bstate&code_challenge=challenge&code_challenge_method=S256";
const APPROVAL_URL =
  "https://app.link.com/activity/approve/lsrq_fixture?key=exact%2Fkey&token=one+two&token=three#review";
const OAUTH_STATE = "wallet-authorization-state-fixture-01234567890123456789";
const TRACKED_CONNECT_URL = CONNECT_URL.replace("exact%2Bstate", OAUTH_STATE);
const AUTHORIZATION_ID = "10000000-0000-4000-a000-000000000001";
const AGENT_ID = "c0000000-0000-4000-a000-000000000071";
const CONTINUATION_PROMPT =
  "Link wallet authorization is complete. Continue the previous task.";

function actionLinks() {
  return queryAllByRoleFast("link").filter((link) => {
    return [
      "Authorize Link wallet",
      "Review purchase",
      "Continue in Link",
    ].includes(link.getAttribute("aria-label") ?? "");
  });
}

async function findControl(role: "button" | "link", name: string) {
  return await waitFor(() => {
    const control = queryAllByRoleFast(role).find((element) => {
      return (
        (element.getAttribute("aria-label") ?? element.textContent?.trim()) ===
        name
      );
    });
    if (!control) {
      throw new Error(`Expected ${role}: ${name}`);
    }
    return control;
  });
}

async function openChat(
  content: string,
  sharedWorkerTestTransport: "direct" | "message-port" = "direct",
  featureSwitches: Partial<Record<FeatureSwitchKey, boolean>> = {},
) {
  const chat = createMarkdownChatFixture(context);
  chat.install({
    rows: () => {
      return [
        chat.outputMessage(content, { seqId: 1 }),
        chat.runCompleted({ seqId: 2 }),
      ];
    },
  });
  await setupPage({
    context,
    path: chat.path,
    host: "app.okou.ai",
    sharedWorkerTestTransport,
    featureSwitches,
  });
}

function mockAuthorization(
  initial: WalletConnectStatus = { status: "pending" },
) {
  context.mocks.http.get("https://login.link.com/auth", () => {
    return HttpResponse.html("<p>Link authorization</p>");
  });
  let status = initial;
  const read = createDeferredPromise<void>(context.signal);
  context.mocks.api(walletUserContract.connectStatus, ({ body, respond }) => {
    expect(body).toStrictEqual({
      agentId: AGENT_ID,
      state: OAUTH_STATE,
    });
    if (!read.settled()) {
      read.resolve();
    }
    return respond(200, status);
  });
  return {
    read: read.promise,
    complete: (notify = true) => {
      status = { status: "authorized", authorizationId: AUTHORIZATION_ID };
      if (notify) {
        context.mocks.ably.trigger("wallet:changed", { orgId: "org_default" });
      }
    },
    fail: (next: "failed" | "unavailable") => {
      status = { status: next };
      context.mocks.ably.trigger("wallet:changed", {
        orgId: "org_default",
        authorized: true,
      });
    },
  };
}

test("a workspace notification completes wallet consent and continues the owning chat once", async () => {
  const authorization = mockAuthorization();
  const attachment = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "wallet:changed",
  );
  const prompts: string[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.agentId).toBe("c0000000-0000-4000-a000-000000000071");
    expect(body.threadId).toBe(context.resourceId);
    expect(body.clientEventId).toBe(AUTHORIZATION_ID);
    expect(body.userMessage).toStrictEqual({
      version: 1,
      parts: [{ type: "text", text: CONTINUATION_PROMPT }],
    });
    prompts.push(body.prompt ?? "");
    return respond(201, {
      threadId: context.resourceId,
    });
  });
  await openChat(TRACKED_CONNECT_URL, "message-port");
  await authorization.read;
  const link = await findControl("link", "Authorize Link wallet");
  expect(link).toHaveAttribute("href", TRACKED_CONNECT_URL);
  expect(prompts).toStrictEqual([]);
  click(link);
  await screen.findByText("Waiting for authorization");
  await attachment.started;
  authorization.complete(false);
  attachment.attach();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("wallet:changed")).toBeTruthy();
  });
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_other" });
  context.mocks.ably.trigger("wallet:changed", { orgId: "" });
  const payload = { orgId: "org_default" };
  context.mocks.ably.trigger("wallet:changed", payload);
  context.mocks.ably.trigger("wallet:changed", payload);
  const completed = await findControl("button", "Authorized");
  expect(completed).toBeDisabled();
  expect(prompts).toStrictEqual([CONTINUATION_PROMPT]);
});

function captureContinuation() {
  const prompts: string[] = [];
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    prompts.push(body.prompt ?? "");
    return respond(201, {
      threadId: context.resourceId,
    });
  });
  return prompts;
}

test("wallet consent completed before the user's click continues from the current authorization", async () => {
  const authorization = mockAuthorization();
  const prompts = captureContinuation();
  await openChat(TRACKED_CONNECT_URL);
  await authorization.read;
  const link = await findControl("link", "Authorize Link wallet");
  expect(link).toHaveAttribute("href", TRACKED_CONNECT_URL);
  await expect(
    screen.findByText("login.link.com"),
  ).resolves.toBeInTheDocument();

  authorization.complete();
  expect(prompts).toStrictEqual([]);
  click(await findControl("button", "Continue"));

  await expect(findControl("button", "Authorized")).resolves.toBeDisabled();
  expect(prompts).toStrictEqual([CONTINUATION_PROMPT]);
});

test("wallet consent notifications queued during attachment still continue the chat", async () => {
  const authorization = mockAuthorization();
  const prompts = captureContinuation();
  const subscription = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "wallet:changed",
  );
  await openChat(TRACKED_CONNECT_URL, "message-port");
  await authorization.read;
  click(await findControl("link", "Authorize Link wallet"));
  await subscription.started;
  authorization.complete();
  subscription.attach();
  await expect(findControl("button", "Authorized")).resolves.toBeDisabled();
  expect(prompts).toStrictEqual([CONTINUATION_PROMPT]);
});

test("wallet consent missed during a connection gap is recovered after reattachment", async () => {
  const authorization = mockAuthorization();
  const prompts = captureContinuation();
  await openChat(TRACKED_CONNECT_URL, "message-port");
  await authorization.read;
  click(await findControl("link", "Authorize Link wallet"));
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("wallet:changed")).toBeTruthy();
  });
  context.mocks.ably.triggerConnectionState("suspended");
  authorization.complete(false);
  context.mocks.ably.triggerConnectionState("connected");
  await expect(findControl("button", "Authorized")).resolves.toBeDisabled();
  expect(prompts).toStrictEqual([CONTINUATION_PROMPT]);
});

test.each([
  ["failed", "Authorization not completed"],
  ["unavailable", "Authorization unavailable"],
] as const)(
  "a %s consent stops waiting without sending a message even when its notification claims authorization",
  async (status, label) => {
    const authorization = mockAuthorization();
    const prompts = captureContinuation();
    await openChat(TRACKED_CONNECT_URL);
    await authorization.read;
    click(await findControl("link", "Authorize Link wallet"));
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription("wallet:changed")).toBeTruthy();
    });
    authorization.fail(status);
    await expect(findControl("button", label)).resolves.toBeDisabled();
    await waitFor(() => {
      expect(context.mocks.ably.hasSubscription("wallet:changed")).toBeFalsy();
    });
    expect(prompts).toStrictEqual([]);
  },
);

test.each([
  {
    outcome: "success",
    message: "Authorized",
    buttonLabel: "Authorized",
  },
  {
    outcome: "failure",
    message: "Authorized. Your message could not be sent.",
    buttonLabel: "Continue",
  },
] as const)(
  "an authorized wallet card reports continuation $outcome after confirmation",
  async ({ outcome, message, buttonLabel }) => {
    mockAuthorization({
      status: "authorized",
      authorizationId: AUTHORIZATION_ID,
    });
    const callbackResponse = context.mocks.deferred<void>();
    context.mocks.api(chatEventsContract.send, async ({ respond }) => {
      await callbackResponse.promise;
      return outcome === "success"
        ? respond(201, { threadId: context.resourceId })
        : respond(500, {
            error: { code: "INTERNAL_ERROR", message: "Response lost" },
          });
    });
    await openChat(TRACKED_CONNECT_URL);
    const next = await findControl("button", "Continue");
    expect(next).toBeEnabled();
    click(next);
    await waitFor(() => {
      expect(next).toBeDisabled();
    });
    callbackResponse.resolve(undefined);
    const [description] = await screen.findAllByText(message);
    expect(description).toBeInTheDocument();
    await expect(findControl("button", buttonLabel)).resolves.toBeDisabled();
  },
);

test.each([
  ["expired", "Authorization expired"],
  ["failed", "Authorization not completed"],
  ["unavailable", "Authorization unavailable"],
] as const)(
  "a %s authorization cannot continue the chat",
  async (status, label) => {
    mockAuthorization({ status });
    const prompts: string[] = [];
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      prompts.push(body.prompt ?? "");
      return respond(201, {
        threadId: context.resourceId,
      });
    });
    await openChat(TRACKED_CONNECT_URL);
    await expect(findControl("button", label)).resolves.toBeDisabled();
    expect(actionLinks()).toHaveLength(0);
    expect(prompts).toStrictEqual([]);
  },
);

test("wallet authorization and purchase links show cards with the exact provider destinations", async () => {
  await openChat(
    `Authorize your wallet\n\n[Reconnect Link](${CONNECT_URL})\n\nReview before buying\n\n${APPROVAL_URL}\n\nWaiting for your review`,
  );

  await screen.findByText("Authorize Link wallet");
  const links = actionLinks();
  expect(links).toHaveLength(2);
  expect(links[0]).toHaveAttribute("href", CONNECT_URL);
  expect(links[0]).toHaveTextContent("Authorize");
  expect(links[1]).toHaveAttribute("href", APPROVAL_URL);
  expect(links[1]).toHaveTextContent("Review");
  for (const link of links) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  expect(screen.getByText("login.link.com")).toBeVisible();
  expect(screen.getByText("app.link.com")).toBeVisible();
  expect(screen.getByText("Review before buying")).toBeVisible();
  expect(screen.getByText("Waiting for your review")).toBeVisible();
});

test("read-only wallet consent renders an authorization card with the exact destination", async () => {
  const url = new URL(CONNECT_URL);
  url.searchParams.set("scope", "userinfo:read");
  url.searchParams.set(
    "authorization_details",
    JSON.stringify([{ type: "source", actions: ["read_link_transactions"] }]),
  );
  await openChat(url.toString());
  await screen.findByText("Authorize Link wallet");
  const links = actionLinks();
  expect(links).toHaveLength(1);
  expect(links[0]).toHaveAttribute("href", url.toString());
  expect(links[0]).toHaveTextContent("Authorize");
});

test("wallet follow-up actions keep provider URLs without inferring payment or approval state", async () => {
  const urls = [
    "https://app.link.com/verify?session=exact%2Fverification",
    "https://app.link.com/finish_setup?verify=3ds",
    "https://app.link.com/add_payment_method",
    "https://app.link.com/update_payment_method",
    "https://app.link.com/select_payment_method",
    "https://app.link.com/identity_verification?session=fixture",
    "https://hooks.stripe.com/redirect/authenticate?client=fixture%2Fexact&return_url=https%3A%2F%2Fapp.link.com%2Factivity",
    "https://hooks.stripe.com/redirect/authenticate/src_fixture?client_secret=fixture%2Fexact",
    "https://hooks.stripe.com/3d_secure_2/hosted?session=fixture%2Fexact",
  ];
  await openChat(urls.join("\n\n"));

  await screen.findAllByText("hooks.stripe.com");
  const links = actionLinks();
  expect(
    links.map((link) => {
      return link.getAttribute("href");
    }),
  ).toStrictEqual(urls);
  for (const link of links) {
    expect(link).toHaveAccessibleName("Continue in Link");
    expect(link).toHaveTextContent("Continue");
  }
  expect(
    screen.queryByText(/payment approved|payment completed|paid successfully/i),
  ).not.toBeInTheDocument();
});

test("both purchase approval URL formats render review actions", async () => {
  const urls = [
    "https://app.link.com/approve/lsrq_fixture",
    "https://app.link.com/approve?request=fixture%2Fapproval&key=exact",
  ];
  await openChat(
    urls
      .map((url) => {
        return `[Review purchase](${url})`;
      })
      .join("\n\n"),
  );

  await waitFor(() => {
    expect(actionLinks()).toHaveLength(2);
  });
  expect(
    actionLinks().map((link) => {
      return link.getAttribute("href");
    }),
  ).toStrictEqual(urls);
  for (const link of actionLinks()) {
    expect(link).toHaveAccessibleName("Review purchase");
  }
});

test("wallet cards preserve signed URL suffixes in Markdown, autolinks and bare links", async () => {
  const base = "https://app.link.com/activity/approve/lsrq_fixture?token=";
  const cases = [
    { url: `${CONNECT_URL}_`, markdown: `[Authorize](${CONNECT_URL}_)` },
    ...["signed_", "signed~", "signed.", "signed?", "signed;"].map((token) => {
      const url = `${base}${token}`;
      return { url, markdown: `[Review](${url})` };
    }),
    { url: `${base}angle_`, markdown: `<${base}angle_>` },
    { url: `${base}bare_`, markdown: `${base}bare_` },
    { url: `${base}bare~`, markdown: `${base}bare~` },
    { url: `${base}bold_`, markdown: `**${base}bold_**` },
    { url: `${base}sentence_`, markdown: `Review: ${base}sentence_.` },
  ];
  await openChat(
    cases
      .map(({ markdown }) => {
        return markdown;
      })
      .join("\n\n") + "\n\nReview each wallet request",
  );

  await screen.findByText("Review each wallet request");
  expect(
    actionLinks().map((link) => {
      return link.getAttribute("href");
    }),
  ).toStrictEqual(
    cases.map(({ url }) => {
      return url;
    }),
  );
});

test("ordinary provider links and untrusted wallet lookalikes stay ordinary links", async () => {
  const urls = [
    "https://link.com",
    "https://support.link.com/questions/link-agent-wallet-faq",
    "https://login.link.com/auth?scope=profile",
    "https://hooks.stripe.com/other-page",
    "https://hooks.stripe.com/redirect/authenticate-other",
    "https://app.link.com.evil.example/activity/approve/fixture",
    "https://app.link.com@evil.example/activity/approve/fixture",
    "https://name:password@app.link.com/activity/approve/fixture",
    "https://app.link.com:8443/activity/approve/fixture",
    "http://app.link.com/activity/approve/fixture",
  ];
  await openChat(
    urls
      .map((url, index) => {
        return `[Reference ${index}](${url})`;
      })
      .join("\n\n"),
  );

  await screen.findByText("Reference 9");
  expect(actionLinks()).toHaveLength(0);
  for (const [index, url] of urls.entries()) {
    expect(screen.getByText(`Reference ${index}`)).toHaveAttribute("href", url);
  }
});

test("wallet URLs in code and user messages do not become action cards", async () => {
  const chat = createMarkdownChatFixture(context);
  chat.install({
    rows: () => {
      return [
        chat.inputPrompt(APPROVAL_URL, { seqId: 1 }),
        chat.outputMessage(
          `Inline: \`${CONNECT_URL}\`\n\n\`\`\`text\n${APPROVAL_URL}\n\`\`\`\n\nThese are code examples`,
          { seqId: 2 },
        ),
        chat.runCompleted({ seqId: 3 }),
      ];
    },
  });
  await setupPage({ context, path: chat.path, host: "app.okou.ai" });

  await screen.findByText("These are code examples");
  expect(actionLinks()).toHaveLength(0);
  expect(document.querySelector("code.language-text")).toHaveTextContent(
    APPROVAL_URL,
  );
});

test("purchase approval cards show approval and continuation after notifications and connection gaps", async () => {
  let status: "pending" | "approved" | "continued" = "pending";
  const attachment = context.mocks.ably.deferSubscribeOnChannel(
    "user:test-user-123",
    "wallet:changed",
  );
  context.mocks.api(walletUserContract.spendStatus, ({ body, respond }) => {
    expect(body).toStrictEqual({
      agentId: AGENT_ID,
      threadId: context.resourceId,
      approvalUrl: APPROVAL_URL,
    });
    return respond(200, { status });
  });
  await openChat(APPROVAL_URL, "message-port", {
    [FeatureSwitchKey.LinkWalletApprovalContinuation]: true,
  });
  await screen.findByText("Waiting for purchase approval");
  const link = await findControl("link", "Review purchase");
  expect(link).toHaveAttribute("href", APPROVAL_URL);
  await attachment.started;
  status = "approved";
  attachment.attach();
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription("wallet:changed")).toBeTruthy();
  });
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_other" });
  expect(
    screen.queryByText("Approved; waiting to continue"),
  ).not.toBeInTheDocument();
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_default" });
  await screen.findByText("Approved; waiting to continue");
  await expect(
    findControl("button", "Status recorded"),
  ).resolves.toBeDisabled();
  context.mocks.ably.triggerConnectionState("suspended");
  status = "continued";
  context.mocks.ably.triggerConnectionState("connected");
  await screen.findByText("Purchase request continued");
  await expect(
    findControl("button", "Status recorded"),
  ).resolves.toBeDisabled();
});

test("a stopped approval watch shows its terminal status", async () => {
  let status: "approved" | "stopped" = "approved";
  context.mocks.api(walletUserContract.spendStatus, ({ respond }) => {
    return respond(200, { status });
  });
  await openChat(APPROVAL_URL, "direct", {
    [FeatureSwitchKey.LinkWalletApprovalContinuation]: true,
  });
  await screen.findByText("Approved; waiting to continue");
  await expect(
    findControl("button", "Status recorded"),
  ).resolves.toBeDisabled();
  status = "stopped";
  context.mocks.ably.trigger("wallet:changed", { orgId: "org_default" });
  await screen.findByText("Automatic waiting has ended.");
  await expect(
    findControl("button", "Status recorded"),
  ).resolves.toBeDisabled();
});
