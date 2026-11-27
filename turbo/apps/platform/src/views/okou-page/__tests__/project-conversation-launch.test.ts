import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { projectsContract } from "@okouai/api-contracts/contracts/projects";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  fill,
  setupPage,
  startPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  project,
  projectEditor,
  chooseProject,
} from "./project-editor-fixtures.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
import { clickComposerAddMenuItem } from "./chat-composer-add-menu-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import { marketingHandoffsContract } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { accountModels } from "./chat-account-model-fixture.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";

const context = testContext();

async function confirmSent(
  workspace: Awaited<ReturnType<typeof projectEditor>>,
  projectId: string | null,
  message: string,
) {
  const send = await waitFor(() => {
    const button = screen.getByLabelText("Send", {
      selector: '[data-slot="chat-composer-card"] button',
    });
    expect(button).toBeEnabled();
    return button;
  });
  click(send);
  const posted = await workspace.created;
  expect(posted.project).toBe(projectId);
  await expect(workspace.sent).resolves.toContain(message);
  await waitFor(() => {
    return expect(location.pathname).toBe("/chats/" + posted.id);
  });
  await expect(
    screen.findByText(message, {
      selector: '[data-message-container] [data-role="user"] *',
    }),
  ).resolves.toBeVisible();
}
test("projects-043 The composer preserves its message while changing from Launch to Campaign and sends to Campaign", async () => {
  const launch = project("Launch"),
    campaign = project("Campaign");
  const ws = await projectEditor(context, [launch, campaign]);
  const text = "Plan the launch";
  await fill(await findComposerEditor(), text);
  await chooseProject(launch.name);
  await screen.findByLabelText("Remove Launch");
  await clickComposerAddMenuItem("Project");
  const menu = within(await screen.findByRole("menu", { name: "Project" }));
  const current = menu.getByText("Launch").closest('[role="menuitemradio"]');
  expect(current).toHaveAttribute("aria-disabled", "true");
  click(menu.getByText("Campaign"));
  await screen.findByLabelText("Remove Campaign");
  await expect(findComposerEditor()).resolves.toHaveTextContent(text);
  await confirmSent(ws, campaign.id, text);
});
test("projects-044 Removing the Launch chip keeps the message and sends it outside any Project", async () => {
  const launch = project("Launch");
  const ws = await projectEditor(context, [launch], {
    path: "/projects/" + launch.id,
  });
  const text = "Outside the launch";
  await fill(await findComposerEditor(), text);
  click(await screen.findByLabelText("Remove Launch"));
  await waitFor(() => {
    return expect(location.pathname).toBe("/");
  });
  expect(screen.queryByLabelText("Remove Launch")).toBeNull();
  await expect(findComposerEditor()).resolves.toHaveTextContent(text);
  await confirmSent(ws, null, text);
});
test("projects-045 The Coffee chip and current menu option display the folder emoji separately from its name", async () => {
  const coffee = project("☕ Coffee");
  await projectEditor(context, [coffee], { path: "/projects/" + coffee.id });
  const remove = await screen.findByLabelText("Remove ☕ Coffee"),
    chip = remove.parentElement!;
  expect(within(chip).getByText("☕")).toBeVisible();
  expect(within(chip).getByText("Coffee")).toBeVisible();
  await clickComposerAddMenuItem("Project");
  const selected = await screen.findByText("Coffee", {
    selector: '[role="menuitemradio"] span.truncate',
  });
  const row = selected.closest('[role="menuitemradio"]')!;
  expect(within(row as HTMLElement).getByText("☕")).toBeVisible();
  expect(row).toHaveAttribute("aria-disabled", "true");
});
test("projects-046 A message entered on Home waits for its new Campaign project to be confirmed before sending", async () => {
  const gate = context.mocks.deferred<void>();
  const ws = await projectEditor(context, [], { createGate: gate.promise });
  const text = "Kick off the campaign";
  await fill(await findComposerEditor(), text);
  await chooseProject("New Project");
  const dialog = await screen.findByRole("dialog", { name: "Create Project" });
  await fill(within(dialog).getByRole("textbox"), "Campaign");
  click(await findFastControl("button", "Save", dialog));
  const id = await ws.creating;
  await waitFor(() => {
    return expect(location.pathname).toBe("/projects/" + id);
  });
  await screen.findByLabelText("Remove Campaign");
  await expect(findComposerEditor()).resolves.toHaveTextContent(text);
  const sending = await findFastControl("button", "Send");
  expect(sending).toBeDisabled();
  click(sending);
  expect(location.pathname).toBe("/projects/" + id);
  gate.resolve();
  await waitFor(() => {
    return expect(
      document.querySelector('button[aria-label="Send"]'),
    ).toBeEnabled();
  });
  await confirmSent(ws, id, text);
});
test("projects-029 Messages composed on the optimistic project home can be sent after creation is confirmed", async () => {
  const gate = context.mocks.deferred<void>();
  const ws = await projectEditor(context, [], { createGate: gate.promise });
  const text = "Confirm the campaign schedule";
  click(await findFastControl("button", "Create Project"));
  const dialog = await screen.findByRole("dialog", { name: "Create Project" });
  await fill(within(dialog).getByRole("textbox"), "Campaign");
  click(await findFastControl("button", "Save", dialog));
  const id = await ws.creating;
  click(await findFastControl("link", "New chat in Campaign"));
  await screen.findByLabelText("Remove Campaign");
  await fill(await findComposerEditor(), text);
  const send = await findFastControl("button", "Send");
  expect(send).toBeDisabled();
  gate.resolve();
  await waitFor(() => {
    return expect(
      document.querySelector('button[aria-label="Send"]'),
    ).toBeEnabled();
  });
  await confirmSent(ws, id, text);
});

test("An empty Project composer stays blank in creation mode with the follow-up switch on", async () => {
  const launch = project("Launch");
  context.mocks.api(projectsContract.snapshot, ({ respond }) => {
    return respond(200, {
      projects: [launch],
      latestEventId: null,
      latestSeqId: 1,
    });
  });
  await setupPage({
    context,
    path: `/projects/${launch.id}`,
    featureSwitches: { [FeatureSwitchKey.FollowupPlaceholder]: true },
  });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  const cards = await screen.findByRole("group", {
    name: "Explore Okou capabilities",
  });
  const create = within(cards).getByRole("region", { name: "Create" });
  click(await findFastControl("button", "Presentation", create));
  await expect(
    screen.findByRole("radiogroup", { name: "Create" }),
  ).resolves.toBeInTheDocument();
  expect(editor).toHaveAttribute("placeholder", "");
  expect(screen.queryByText("What is your presentation about?")).toBeNull();
});

type Fixture = NonNullable<Parameters<typeof mockChatLifecycle>[1]>;
type Sent = Parameters<NonNullable<Fixture["onSendRequest"]>>[0];
type Created = Parameters<NonNullable<Fixture["onThreadCreate"]>>[0];
function conversation() {
  const sent: Sent[] = [];
  const created: Created[] = [];
  mockChatLifecycle(context, {
    onSendRequest(body) {
      sent.push(body);
    },
    onThreadCreate(body) {
      created.push(body);
    },
  });
  return { sent, created };
}
test("prompt-link-002 Opening a Home prompt link prefills an editable draft without sending it", async () => {
  const prompt = "Outline the customer interview";
  const suffix = " questions";
  const requests = conversation();
  await setupPage({
    context,
    path: "/?" + new URLSearchParams({ prompt }).toString(),
  });
  const composer = await findComposerEditor();
  await waitFor(() => {
    expect(composer).toHaveTextContent(prompt);
  });
  composer.focus();
  const user = userEvent.setup({ delay: null });
  {
    const selection = window.getSelection();
    selection?.selectAllChildren(composer);
    selection?.collapseToEnd();
    await user.paste(suffix);
  }
  expect(composer.textContent).toBe(prompt + suffix);
  expect(location.pathname).toBe("/");
  expect(location.search).toBe("");
  expect(requests.sent).toStrictEqual([]);
  expect(requests.created).toStrictEqual([]);
});
test.each([
  [
    "prompt-link-009",
    "cozy-parlor",
    "Cozy Parlor",
    {
      type: "illustration",
      selection: { illustrationStyleId: "image-style:cozy-parlor" },
    },
  ],
  [
    "prompt-link-010",
    "playful-launch-presentation",
    "Sunburst playroom",
    {
      type: "presentation",
      selection: {
        templateId: "template:html-ppt-playful-launch",
        colorSystemId: "color-system:carnival",
        previewUrl: expect.stringMatching(/playful-launch-presentation\.html$/),
      },
    },
  ],
  [
    "prompt-link-012",
    "website-template:black-slabs",
    "Black Slabs",
    {
      type: "website",
      selection: { websiteTemplateId: "website-template:black-slabs" },
    },
  ],
] as const)(
  "%s A prompt link sends the selected %s template snapshot to its new conversation",
  async (_id, template, title, expected) => {
    const captured = conversation();
    const prompt = "Prepare the launch materials";
    await setupPage({
      context,
      path: "/prompt?" + new URLSearchParams({ prompt, template }).toString(),
    });
    await waitFor(() => {
      expect(location.pathname).toMatch(/^\/chats\//);
    });
    await waitFor(() => {
      expect(captured.sent.at(-1)?.userMessage?.parts).toContainEqual({
        type: "template",
        titleSnapshot: title,
        template: expected,
      });
    });
    const message = await screen.findByText(prompt, { exact: true });
    expect(message).toBeVisible();
    expect(location.search).toBe("");
    expect(captured.created.at(-1)?.modelSelection).toBeNull();
    expect(
      captured.sent.at(-1)?.userMessage?.parts.filter((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual([]);
  },
);

type Lifecycle = NonNullable<Parameters<typeof mockChatLifecycle>[1]>;
function receivePrompt() {
  const created =
    context.mocks.deferred<
      Parameters<NonNullable<Lifecycle["onThreadCreate"]>>[0]
    >();
  const sent =
    context.mocks.deferred<
      Parameters<NonNullable<Lifecycle["onSendRequest"]>>[0]
    >();
  const run =
    context.mocks.deferred<
      Parameters<NonNullable<Lifecycle["onRunCreate"]>>[0]
    >();
  mockChatLifecycle(context, {
    onThreadCreate: created.resolve,
    onSendRequest: sent.resolve,
    onRunCreate: run.resolve,
  });
  return { created: created.promise, sent: sent.promise, run: run.promise };
}

test("prompt-link-005 A launch link sends its text and selected model without inheriting the connector or Fast preference", async () => {
  const model = "gpt-6-astra",
    prompt = "Compare the launch options";
  accountModels(
    context,
    [model],
    model,
    { [model]: { effort: "low" } },
    "priority",
  );
  const request = receivePrompt();
  await setupPage({
    context,
    path:
      "/prompt?" +
      new URLSearchParams({ prompt, model, connector: "github" }).toString(),
  });
  const created = await request.created;
  expect(created.model).toBe(model);
  const sent = await request.sent;
  expect((await request.run).runOptions?.codexServiceTier).toBeUndefined();
  expect(sent.userMessage?.parts).toStrictEqual([
    { type: "text", text: prompt },
    { type: "model", selectedModel: model },
  ]);
  await expect(
    screen.findByText(prompt, { exact: true }),
  ).resolves.toBeVisible();
  expect(location.pathname).toMatch(/^\/chats\//);
  expect(location.search).toBe("");
});

test("prompt-link-013 An unavailable requested model keeps the link and the visitor's separate saved draft intact", async () => {
  const model = "gpt-5.6-sol",
    prompt = "Investigate the sales report";
  const saved = textContinuityDraft("Unrelated saved draft");
  accountModels(context, [], null);
  const writes: string[] = [];
  mockChatLifecycle(context, {
    onThreadCreate: () => {
      return writes.push("create");
    },
    onSendRequest: () => {
      return writes.push("send");
    },
  });
  context.mocks.api(composerDraftContract.get, ({ respond }) => {
    return respond(200, saved);
  });
  context.mocks.api(composerDraftContract.patch, ({ respond }) => {
    writes.push("draft");
    return respond(204);
  });
  await startPage({
    context,
    path: "/prompt?" + new URLSearchParams({ model, prompt }).toString(),
  });
  await expect(
    screen.findByText(
      /selected model.*(unavailable|not available|no longer available)/i,
    ),
  ).resolves.toBeVisible();
  expect(location.pathname).toBe("/prompt");
  expect(
    Object.fromEntries(new URLSearchParams(location.search)),
  ).toStrictEqual({ model, prompt });
  expect(writes).toStrictEqual([]);
});

test("prompt-link-018 A file-only handoff opens a chat with the privately imported notes attachment", async () => {
  const hash = "fc".repeat(32),
    name = "notes.txt",
    fileId = crypto.randomUUID();
  const file = { filename: name, contentType: "text/plain", size: 12 };
  context.mocks.api(
    marketingHandoffsContract.resolve,
    ({ params, respond }) => {
      expect(params.hash).toBe(hash);
      return respond(200, {
        version: 1,
        prompt: "",
        options: {},
        files: [{ ...file, hash: "ab".repeat(32) }],
      });
    },
  );
  context.mocks.api(marketingHandoffsContract.import, ({ params, respond }) => {
    expect(params.hash).toBe(hash);
    return respond(200, {
      files: [
        { ...file, id: fileId, url: "https://app.test/artifacts/" + fileId },
      ],
    });
  });
  const request = receivePrompt();
  await setupPage({ context, path: "/prompt?handoff=" + hash });
  const message = await request.sent;
  expect(message.userMessage?.parts).toContainEqual(
    expect.objectContaining({ type: "file", fileId, filenameSnapshot: name }),
  );
  await waitFor(() => {
    return expect(location.pathname).toMatch(/^\/chats\//);
  });
  expect(location.search).toBe("");
  await expect(screen.findByText(name)).resolves.toBeVisible();
});
