import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import userEvent from "@testing-library/user-event";
import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
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
} from "./chat-run-test-fixtures.ts";
import { composerModelTrigger } from "./chat-composer-test-helpers.ts";

const context = testContext();

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

  await setupPage({ context, path: "/" });
  await composerModelTrigger("Claude Sonnet 5");
  await fill(
    await screen.findByRole("textbox", { name: "Message" }),
    "Review the release",
  );
  click(await findEnabledButton("Send"));
  const identity = await submitted.promise;
  const list = within(await screen.findByTestId("chat-list-column"));
  try {
    await waitFor(() => {
      return expect(sidebarThreadTitles()).toStrictEqual(["New chat"]);
    });
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

test("A QuickTime attachment appears in the pending conversation before its title is confirmed", async () => {
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
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    release.resolve();
  }
});
