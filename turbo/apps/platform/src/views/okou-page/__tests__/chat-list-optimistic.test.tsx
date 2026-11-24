import { accountModels } from "./chat-account-model-fixture.ts";
import {
  openModelPanel,
  findModelOption,
  closeModelPanel,
} from "./chat-model-panel-test-helpers.ts";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import userEvent from "@testing-library/user-event";
import {
  chatThreadsContract,
  chatThreadDraftContract,
  chatThreadArtifactsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { screen, within, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  chatListEvent,
  installChatListStream,
  installChatListRunModels,
  sidebarThreadLinks,
  sidebarThreadTitles,
} from "./chat-list-test-helpers.ts";
import {
  createChatRunFixtures,
  findEnabledButton,
  RUN_PATH,
} from "./chat-run-test-fixtures.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";

const context = testContext();
const savedDraft = "Continue the saved shipment review";
function offerServerDraft() {
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftAttachments: null,
      draftUserMessage: {
        version: 1,
        parts: [{ type: "text", text: savedDraft }],
      },
    });
  });
}

test("chat-list-optimistic-007 reconciles the temporary sidebar destination with the confirmed title", async () => {
  const submitted = context.mocks.deferred<{ id: string; event: string }>();
  const confirm = context.mocks.deferred<void>();
  const createAccepted = context.mocks.deferred<void>();
  createChatRunFixtures(context).installRunChat({
    selectedModel: "claude-sonnet-5",
    onSendRequest: () => {
      return createAccepted.resolve();
    },
  });
  installChatListRunModels(context);
  const stream = installChatListStream(context, { caseId: 292, snapshot: [] });
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    if (!body.clientThreadId || !body.eventId) {
      throw new Error("Missing client identity on create");
    }
    submitted.resolve({ id: body.clientThreadId, event: body.eventId });
    await confirm.promise;
    return respond(201, {
      id: body.clientThreadId,
      title: null,
      createdAt: "2026-09-19T10:00:00Z",
      selectedModel: body.model ?? "claude-sonnet-5",
      serviceTier: null,
    });
  });

  offerServerDraft();
  await setupPage({ context, path: "/" });
  await composerModelTrigger("Claude Sonnet 5");
  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Start the local conversation.",
  );
  click(await findEnabledButton("Send"));
  const identity = await submitted.promise;
  const list = within(await screen.findByTestId("chat-list-column"));
  try {
    await waitFor(() => {
      return expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
    });
    const composer = screen.getByRole("textbox", { name: "Message" });
    expect(composer).not.toHaveTextContent(savedDraft);
    expect(sidebarThreadLinks()[0]).toHaveAttribute(
      "href",
      `/chats/${identity.id}`,
    );
  } finally {
    confirm.resolve();
  }
  await createAccepted.promise;
  stream.setEvents([
    chatListEvent(292, 2, "created", identity.id, {
      id: identity.event,
      title: "Confirmed conversation",
    }),
  ]);
  context.mocks.ably.trigger("threadListChanged");
  await list.findByText("Confirmed conversation");
  expect(sidebarThreadTitles()).toStrictEqual(["Confirmed conversation"]);
  expect(sidebarThreadLinks()[0]).toHaveAttribute(
    "href",
    `/chats/${identity.id}`,
  );
});

test("The pending QuickTime preview uses its conversation when the member opens the recording", async () => {
  const movie = {
    id: crypto.randomUUID(),
    filename: "recording.mov",
    contentType: "video/quicktime",
    size: 5,
    url: "https://files.example.org/review/recording.mov",
  };
  context.mocks.upload.success(movie);
  const receipt = context.mocks.deferred<string>(),
    release = context.mocks.deferred<void>();
  createChatRunFixtures(context).installRunChat({
    selectedModel: "claude-sonnet-5",
  });
  context.mocks.api(webFilesContract.fileUrl, ({ query, respond }) => {
    return query.file_id === movie.id
      ? respond(200, {
          url: movie.url,
          downloadUrl: movie.url,
          expiresAt: "2099-01-01T00:00:00Z",
          publicUrl: movie.url,
        })
      : respond(404, {
          error: { code: "FILE_NOT_FOUND", message: "Missing file" },
        });
  });
  installChatListRunModels(context);
  installChatListStream(context, { caseId: 901, snapshot: [] });
  context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
    const id = body.clientThreadId!;
    receipt.resolve(id);
    await release.promise;
    return respond(201, {
      id,
      title: null,
      createdAt: "2026-11-23T00:00:00Z",
      selectedModel: body.model ?? "claude-sonnet-5",
      serviceTier: null,
    });
  });
  const catalog = context.mocks.deferred<string>();
  context.mocks.api(chatThreadArtifactsContract.list, ({ params, respond }) => {
    catalog.resolve(params.threadId);
    return respond(200, { runs: [] });
  });
  await setupPage({ context, path: "/" });
  await composerModelTrigger("Claude Sonnet 5");
  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Review the recorded clip.",
  );
  await userEvent
    .setup({ delay: null })
    .upload(
      await screen.findByLabelText("Attach", { selector: "input" }),
      new File(["movie"], movie.filename, { type: movie.contentType }),
    );
  await findEnabledButton("Remove recording.mov");
  click(await findEnabledButton("Send"));
  const id = await receipt.promise;
  try {
    await waitFor(() => {
      return expect(sidebarThreadLinks()[0]).toHaveAttribute(
        "href",
        "/chats/" + id,
      );
    });
    await screen.findByText("Review the recorded clip.");
    await waitFor(() => {
      return expect(document.querySelector("video")?.getAttribute("src")).toBe(
        movie.url + "#t=0.001",
      );
    });
    expect(screen.queryByText("Chat thread not found")).toBeNull();
    click(await findEnabledButton("Preview recording.mov"));
    await expect(catalog.promise).resolves.toBe(id);
    await findEnabledButton("Close artifact");
    expect(sidebarThreadLinks()[0]).toHaveAttribute("href", "/chats/" + id);
  } finally {
    release.resolve();
  }
});

test("The confirmed conversation restores the shipment draft supplied by the same draft endpoint", async () => {
  createChatRunFixtures(context).installRunChat({
    selectedModel: "claude-sonnet-5",
  });
  offerServerDraft();
  await setupPage({ context, path: RUN_PATH });
  const editor = await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    return expect(editor).toHaveTextContent(savedDraft);
  });
});

test.each([
  ["chat-list-optimistic-001", false, "Start the local conversation."],
  ["chat-list-optimistic-005", true, "Review the winter shipment"],
] as const)(
  "%s the pending conversation keeps the requested destination and model",
  async (_case, changeModel, prompt) => {
    const creation = context.mocks.deferred<{
      id: string;
      model: string | null | undefined;
    }>();
    const acknowledge = context.mocks.deferred<void>();
    const initialModel = changeModel ? "gpt-5.6-luna" : "claude-sonnet-5";
    createChatRunFixtures(context).installRunChat({
      selectedModel: initialModel,
    });
    accountModels(context, ["gpt-5.6-luna", "claude-sonnet-5"], initialModel);
    installChatListStream(context, { caseId: 475, snapshot: [] });
    offerServerDraft();
    context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
      const id = body.clientThreadId;
      if (!id) {
        throw new Error("Expected the new conversation's ID");
      }
      creation.resolve({ id, model: body.model });
      await acknowledge.promise;
      return respond(201, {
        id,
        selectedModel: body.model ?? null,
        serviceTier: null,
        createdAt: "2026-11-24T00:00:00Z",
        title: null,
      });
    });
    await setupPage({ context, path: "/" });
    if (changeModel) {
      const models = await openModelPanel("GPT 5.6 Luna");
      click(await findModelOption("Claude Sonnet 5", models));
      await composerModelTrigger("Claude Sonnet 5");
      await closeModelPanel();
    }
    const editor = await screen.findByRole("textbox", { name: "Message" });
    await fill(editor, prompt);
    expect(editor).toHaveTextContent(prompt);
    click(await findEnabledButton("Send"));
    try {
      const { id, model } = await creation.promise;
      expect(model).toBe("claude-sonnet-5");
      await expect(
        composerModelTrigger("Claude Sonnet 5"),
      ).resolves.toBeVisible();
      await waitFor(() => {
        expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
        expect(sidebarThreadLinks()[0]).toHaveAttribute("href", "/chats/" + id);
      });
      expect(
        screen.getByRole("textbox", { name: "Message" }),
      ).not.toHaveTextContent(savedDraft);
    } finally {
      acknowledge.resolve();
    }
  },
);
