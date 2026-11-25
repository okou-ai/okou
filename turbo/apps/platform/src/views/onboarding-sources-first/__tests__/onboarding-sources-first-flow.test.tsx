import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorCatalogConnectItem } from "../../../mocks/handlers/api-connectors.ts";
import { expect, test } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import {
  onboardingRecommendationContract,
  onboardingSourcesContract,
  onboardingCompleteContract,
  onboardingDraftContract,
} from "@okouai/api-contracts/contracts/onboarding";
import { billingRedeemCodeContract } from "@okouai/api-contracts/contracts/billing";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import {
  findAction,
  mockSlack,
  getAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
import {
  connectedGmailSource,
  mockOnboardingConnectorCatalog,
  onboardingSourceItem,
} from "./onboarding-catalog-test-helpers.ts";
import {
  receiveFirstChat,
  findSentPrompt,
  documentInstructions,
} from "./onboarding-first-chat-test-helpers.ts";

const context = testContext();
const task = "Draft the launch plan";
function newcomer(isAdmin = true) {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
    isAdmin,
  });
}
function unconnectedGmail(ready?: Promise<void>, onList?: () => void) {
  mockOnboardingConnectorCatalog(
    context,
    [
      onboardingSourceItem({
        slug: "gmail",
        label: "Gmail",
        description: "Read work email",
        hasAccount: false,
      }),
    ],
    { ready, onList },
  );
}
function savedPlan(text: string) {
  context.mocks.api(onboardingDraftContract.get, ({ respond }) => {
    return respond(200, {
      draft: {
        revision: crypto.randomUUID(),
        step: "ready",
        answers: {
          industry: "marketing",
          experienced: false,
          provider: null,
          startingPromptDraft: text,
          startingPromptKey: "edited",
          startingPromptOutput: null,
          recommendationJobId: null,
          recommendationStartedAt: null,
        },
      },
    });
  });
}
test("onboarding-sources-first-flow-001 the industry choice survives visiting the disconnected Gmail step", async () => {
  newcomer();
  const release = context.mocks.deferred<void>();
  const requested = context.mocks.deferred<void>();
  unconnectedGmail(release.promise, () => {
    if (!requested.settled()) {
      requested.resolve();
    }
  });
  await setupPage({ context, path: "/onboarding" });
  const next = await findAction("button", "Continue");
  expect(next).toBeDisabled();
  click(await screen.findByText("Marketing & content"));
  expect(next).toBeEnabled();
  click(next);
  try {
    await requested.promise;
    expect(
      screen.queryByRole("status", { name: "Loading" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "What kind of work do you do?" }),
    ).toBeVisible();
    expect(location.pathname).toBe("/onboarding");
  } finally {
    release.resolve();
  }
  await screen.findByRole("heading", { name: "Connect a work tool" });
  await expect(findAction("button", "Connect Gmail")).resolves.toBeEnabled();
  expect(getAction("button", "Continue")).toBeDisabled();
  click(getAction("button", "Back"));
  await expect(
    screen.findByRole("radio", { name: /Marketing & content/ }),
  ).resolves.toBeChecked();
});
test("onboarding-sources-first-flow-006 canceling and confirming Skip preserves the redeem code through Back", async () => {
  newcomer();
  unconnectedGmail();
  await setupPage({ context, path: "/onboarding/sources?redeemCode=LAUNCH50" });
  click(await findAction("button", "Skip"));
  const confirm = await screen.findByRole("dialog");
  click(getAction("button", "Connect a tool", confirm));
  await expect(findAction("button", "Connect Gmail")).resolves.toBeEnabled();
  click(getAction("button", "Skip"));
  click(getAction("button", "Skip for now", await screen.findByRole("dialog")));
  await screen.findByRole("heading", {
    name: "How would you like to start with Okou?",
  });
  expect(new URL(location.href).searchParams.get("redeemCode")).toBe(
    "LAUNCH50",
  );
  click(getAction("button", "Back"));
  await expect(findAction("button", "Connect Gmail")).resolves.toBeEnabled();
  expect(getAction("button", "Continue")).toBeDisabled();
  expect(getAction("button", "Skip")).toBeEnabled();
});
test("onboarding-sources-first-flow-013 the saved marketing launch plan reaches its chat and completion receipt", async () => {
  newcomer();
  const text = "Draft my launch plan.";
  savedPlan(text);
  const completed = createDeferredPromise<string | undefined | null>(
    context.signal,
  );
  context.mocks.api(
    onboardingCompleteContract.complete,
    ({ body, respond }) => {
      if (!completed.settled()) {
        completed.resolve(body.industry);
      }
      context.mocks.data.onboardingStatus({
        needsOnboarding: false,
        onboardingComplete: true,
      });
      return respond(200, { needsOnboarding: false, onboardingComplete: true });
    },
  );
  const sent = receiveFirstChat(context);
  await setupPage({ context, path: "/onboarding/ready" });
  await expect(screen.findByLabelText("Your first task")).resolves.toHaveValue(
    text,
  );
  click(await findAction("button", "Start my first task"));
  expect((await sent).prompt).toBe(text);
  await expect(completed.promise).resolves.toBe("marketing");
  await expect(findSentPrompt(text)).resolves.toBeVisible();
});
test.each([
  ["onboarding-sources-first-flow-014", true, "Draft my launch plan"],
  [
    "onboarding-sources-first-flow-022",
    false,
    "Draft the launch plan for the EU market",
  ],
] as const)(
  "%s keeps the edited request on screen until the status handoff finishes",
  async (_id, ready, text) => {
    newcomer();
    if (ready) {
      savedPlan(text);
    }
    let completed = false;
    const held = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    context.mocks.api(onboardingCompleteContract.complete, ({ respond }) => {
      completed = true;
      context.mocks.data.onboardingStatus({
        onboardingComplete: true,
        needsOnboarding: false,
      });
      return respond(200, { needsOnboarding: false, onboardingComplete: true });
    });
    context.mocks.api(userModelPreferenceContract.get, async ({ respond }) => {
      if (completed) {
        if (!held.settled()) {
          held.resolve();
        }
        await release.promise;
      }
      return respond(200, {
        selectedModel: null,
        serviceTier: null,
        modelSettings: {},
        selectedImageModel: null,
        updatedAt: null,
      });
    });
    const sent = receiveFirstChat(context);
    await setupPage({
      context,
      path: ready
        ? "/onboarding/ready"
        : "/onboarding?prompt=" + encodeURIComponent(task),
    });
    const editor = await screen.findByLabelText(
      ready ? "Your first task" : "Onboarding prompt",
    );
    if (!ready) {
      await fill(editor, text);
    }
    click(await findAction("button", ready ? "Start my first task" : "Next"));
    try {
      await held.promise;
      expect(editor).toBeVisible();
      expect(editor).toHaveValue(text);
    } finally {
      release.resolve();
    }
    const expected = ready ? text : text + "\n\n" + documentInstructions;
    const chat = await sent;
    expect(chat.prompt).toBe(expected);
    await expect(findSentPrompt(expected)).resolves.toBeVisible();
    expect(location.pathname).toBe("/chats/" + chat.threadId);
  },
);
test("onboarding-sources-first-flow-017 a launch-plan link opens the guided single-step task", async () => {
  newcomer();
  await setupPage({
    context,
    path: "/onboarding?prompt=Draft+the+launch+plan",
  });
  await expect(
    screen.findByLabelText("Onboarding prompt"),
  ).resolves.toHaveValue(task);
  expect(
    screen.getByText(
      "Connect your apps for better results and choose a format.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("region", { name: /compliance/i })).toBeVisible();
  expect(getAction("button", "Next")).toBeEnabled();
  expect(
    screen.queryByText("What kind of work do you do?"),
  ).not.toBeInTheDocument();
});
test("onboarding-sources-first-flow-020 the submitted document keeps its showcase destination", async () => {
  newcomer();
  const sent = receiveFirstChat(context);
  const showcase = "https://examples.test/launch";
  await setupPage({
    context,
    path: "/onboarding?" + new URLSearchParams({ prompt: task, showcase }),
  });
  click(await findAction("button", "Next"));
  const expected = task + "\n\n" + documentInstructions;
  const chat = await sent;
  expect(chat.prompt).toBe(expected);
  await expect(findSentPrompt(expected)).resolves.toBeVisible();
  expect(new URL(location.href).searchParams.get("showcase")).toBe(showcase);
});
test("onboarding-sources-first-flow-023 a linked coastal hotel website template reaches the first chat", async () => {
  newcomer();
  const template = "website-template:coastal-hotel";
  const received = createDeferredPromise<string>(context.signal);
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    expect(body.userMessage?.parts).toContainEqual({
      type: "template",
      titleSnapshot: "Coastal Hotel",
      template: { type: "website", selection: { websiteTemplateId: template } },
    });
    if (!body.threadId) {
      throw new Error("Missing destination");
    }
    if (!received.settled()) {
      received.resolve(body.threadId);
    }
    return respond(201, {
      threadId: body.threadId,
      createdAt: "2026-10-15T10:20:00Z",
    });
  });
  await setupPage({
    context,
    path:
      "/onboarding?" +
      new URLSearchParams({ prompt: "Build a hotel website.", template }),
  });
  click(await findAction("button", "Next"));
  const threadId = await received.promise;
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + threadId);
  });
});
test("onboarding-sources-first-flow-026 a launch task arriving on sources opens the prompt editor", async () => {
  newcomer();
  await setupPage({
    context,
    path: "/onboarding/sources?prompt=Draft+the+launch+plan",
  });
  await expect(
    screen.findByLabelText("Onboarding prompt"),
  ).resolves.toHaveValue(task);
  expect(location.pathname).toBe("/onboarding");
});
test.each([
  ["onboarding-sources-first-flow-027", false, task],
  ["onboarding-sources-first-flow-028", true, "   "],
] as const)(
  "%s opens the industry question with its own membership and task",
  async (_id, owner, prompt) => {
    newcomer(owner);
    await setupPage({
      context,
      path: "/onboarding?" + new URLSearchParams({ prompt }),
    });
    await expect(
      screen.findByRole("heading", { name: "What kind of work do you do?" }),
    ).resolves.toBeVisible();
    expect(
      screen.queryByLabelText("Onboarding prompt"),
    ).not.toBeInTheDocument();
  },
);
test("onboarding-sources-first-flow-034 an onboarded owner redeems PRO-CAMPAIGN and reaches Home", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: false,
    onboardingComplete: true,
  });
  const code = createDeferredPromise<string>(context.signal);
  context.mocks.api(billingRedeemCodeContract.create, ({ body, respond }) => {
    if (!code.settled()) {
      code.resolve(body.code);
    }
    return respond(200, { redeemed: true });
  });
  await setupPage({ context, path: "/onboarding?redeemCode=PRO-CAMPAIGN" });
  await expect(
    screen.findByRole("textbox", { name: "Message" }),
  ).resolves.toBeVisible();
  await expect(code.promise).resolves.toBe("PRO-CAMPAIGN");
  expect(location.pathname).toBe("/");
  expect(new URL(location.href).searchParams.has("redeemCode")).toBeFalsy();
});
test("onboarding-sources-first-flow-019 saving an Ahrefs API token preserves the keyword task", async () => {
  newcomer();
  await setupPage({
    context,
    path: "/onboarding?prompt=Track+keyword+rankings.&connector=ahrefs",
  });
  click(await findAction("button", "Connect Ahrefs"));
  const dialog = await screen.findByRole("dialog");
  await fill(
    within(dialog).getByPlaceholderText("your-ahrefs-api-token"),
    "example-ahrefs-token",
  );
  click(getAction("button", "Save", dialog));
  await waitFor(() => {
    return expect(dialog).not.toBeInTheDocument();
  });
  await expect(
    screen.findByText("Ahrefs connected successfully"),
  ).resolves.toBeVisible();
  expect(screen.getByLabelText("Onboarding prompt")).toHaveValue(
    "Track keyword rankings.",
  );
});

test("onboarding-sources-first-flow-009 the invited member receives the delayed Gmail recommendation using the onboarding catalog", async () => {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: true,
    isAdmin: false,
  });
  mockSlack(context, { isAdmin: false, installUrl: null });
  mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
  const jobId = crypto.randomUUID(),
    req = context.mocks.deferred<unknown>();
  let ready = false;
  const accessed = new Set<string>();
  context.mocks.api(onboardingSourcesContract.list, ({ request, respond }) => {
    accessed.add(new URL(request.url).pathname);
    return respond(200, {
      connectors: [connectorCatalogConnectItem(connectedGmailSource())],
    });
  });
  context.mocks.api(connectorCatalogContract.status, ({ request, respond }) => {
    accessed.add(new URL(request.url).pathname);
    return respond(200, { connectors: [] });
  });
  context.mocks.api(
    onboardingRecommendationContract.start,
    ({ body, respond }) => {
      if (!req.settled()) {
        req.resolve(body);
      }
      return respond(202, { jobId, status: "pending" });
    },
  );
  const prompt = "Review the Gmail replies that need my decision today.";
  const title = "Clear the replies that matter";
  context.mocks.api(onboardingRecommendationContract.get, ({ respond }) => {
    return respond(
      200,
      ready
        ? {
            jobId,
            status: "completed",
            recommendation: {
              title,
              prompt,
              kind: "task",
              outcome: "Decide which replies to send",
              profile: {
                overview: "Marketing",
                professionalIdentity: [],
                communicationStyle: [],
                priorities: [],
              },
            },
          }
        : { jobId, status: "running" },
    );
  });
  await setupPage({ context, path: "/onboarding" });
  click(await screen.findByText("Marketing & content"));
  click(await findAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Connect a work tool" });
  await waitFor(() => {
    return expect(getAction("button", "Continue")).toBeEnabled();
  });
  click(getAction("button", "Continue"));
  click(await screen.findByText("Start with Okou"));
  click(await findAction("button", "Continue"));
  await screen.findByRole("heading", { name: "Keep Okou a message away" });
  click(await findAction("button", "Not now"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding/capabilities");
  });
  click(await findAction("button", "Continue"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/onboarding/ready");
  });
  expect(screen.queryByDisplayValue(prompt)).not.toBeInTheDocument();
  expect(screen.queryByText(title)).not.toBeInTheDocument();
  await expect(req.promise).resolves.toMatchObject({
    industry: "marketing",
    locale: "en-US",
  });
  await waitFor(() => {
    return expect(
      context.mocks.ably.hasSubscription("onboardingRecommendationChanged"),
    ).toBeTruthy();
  });
  ready = true;
  context.mocks.ably.trigger("onboardingRecommendationChanged", { jobId });
  await waitFor(() => {
    return expect(screen.getByLabelText("Your first task")).toHaveValue(prompt);
  });
  await expect(screen.findByText(title)).resolves.toBeVisible();
  expect(accessed.has("/api/onboarding/sources")).toBeTruthy();
  expect(accessed.has("/api/connector-catalog/status")).toBeFalsy();
});

test.each([
  ["onboarding-sources-first-flow-012", "owner"],
  ["onboarding-sources-first-flow-015", "invited member"],
] as const)(
  "%s The %s starts the chosen task only after the ready-step completion is accepted",
  async (_case, role) => {
    const owner = role === "owner";
    newcomer(owner);
    mockSlack(context, {
      isAdmin: owner,
      installUrl: owner ? "/slack/install" : null,
    });
    const proposed =
      "Compare the public content of three competitors and suggest three angles for my brand. Ask me which brand and audience to focus on.";
    const edited = owner ? "Prepare my field guide" : "Draft my meeting agenda";
    if (owner) {
      mockOnboardingConnectorCatalog(context, [connectedGmailSource()]);
      savedPlan(edited);
    } else {
      unconnectedGmail();
    }
    const submitting = context.mocks.deferred<string>();
    const release = context.mocks.deferred<void>();
    let accepted = false;
    context.mocks.api(
      onboardingCompleteContract.complete,
      async ({ respond }) => {
        if (!submitting.settled()) {
          submitting.resolve(location.pathname);
        }
        await release.promise;
        accepted = true;
        context.mocks.data.onboardingStatus({
          onboardingComplete: true,
          needsOnboarding: false,
        });
        return respond(200, {
          onboardingComplete: true,
          needsOnboarding: false,
        });
      },
    );
    const sent = context.mocks.deferred<{
      text: string | undefined;
      ready: boolean;
      to: string | undefined;
    }>();
    context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
      const to = body.threadId;
      if (!to) {
        throw new Error("Expected a conversation for the first task");
      }
      if (!sent.settled()) {
        sent.resolve({ text: body.prompt, ready: accepted, to });
      }
      return respond(201, { threadId: to, createdAt: "2026-10-18T09:00:00Z" });
    });
    try {
      await setupPage({
        context,
        path: owner ? "/onboarding/ready" : "/onboarding",
      });
      if (!owner) {
        click(
          await screen.findByRole("radio", { name: /Marketing & content/ }),
        );
        click(await findAction("button", "Continue"));
        click(await findAction("button", "Skip"));
        click(
          await findAction(
            "button",
            "Skip for now",
            await screen.findByRole("dialog"),
          ),
        );
        click(await screen.findByText("Start with Okou"));
        click(await findAction("button", "Continue"));
        click(await findAction("button", "Not now"));
        await screen.findByRole("heading", {
          name: "More ways to get your work done",
        });
        click(await findAction("button", "Continue"));
      }
      const editor = await screen.findByLabelText("Your first task");
      expect(editor).toHaveValue(owner ? edited : proposed);
      if (!owner) {
        await fill(editor, edited);
      }
      click(await findAction("button", "Start my first task"));
      await expect(submitting.promise).resolves.toBe("/onboarding/ready");
      expect(editor).toHaveValue(edited);
      release.resolve();
      const run = await sent.promise;
      expect(run.text).toBe(edited);
      expect(run.ready).toBeTruthy();
      await findSentPrompt(edited);
      await waitFor(() => {
        return expect(location.pathname).toBe("/chats/" + run.to);
      });
    } finally {
      if (!release.settled()) {
        release.resolve();
      }
    }
  },
);

test("onboarding-sources-first-flow-021 The edited launch prompt reaches the new chat after the onboarding page accepts completion", async () => {
  newcomer();
  const completing = context.mocks.deferred<string>();
  const allow = context.mocks.deferred<void>();
  context.mocks.api(
    onboardingCompleteContract.complete,
    async ({ respond }) => {
      completing.resolve(location.pathname);
      await allow.promise;
      context.mocks.data.onboardingStatus({
        needsOnboarding: false,
        onboardingComplete: true,
      });
      return respond(200, { needsOnboarding: false, onboardingComplete: true });
    },
  );
  const first = receiveFirstChat(context);
  const edited = "Draft the launch plan for the EU market";
  await setupPage({
    context,
    path: "/onboarding?prompt=" + encodeURIComponent(task),
  });
  const input = await screen.findByLabelText("Onboarding prompt");
  expect(input).toHaveValue("Draft the launch plan");
  await fill(input, edited);
  click(await findAction("button", "Next"));
  try {
    await expect(completing.promise).resolves.toBe("/onboarding");
    expect(input).toHaveValue(edited);
  } finally {
    allow.resolve();
  }
  const chat = await first;
  expect(chat.prompt).toBe(edited + "\n\n" + documentInstructions);
  await expect(findSentPrompt(chat.prompt)).resolves.toBeVisible();
  expect(location.pathname).toBe("/chats/" + chat.threadId);
});
