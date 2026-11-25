import { composerDraftContract } from "@okouai/api-contracts/contracts/composer-draft";
import { marketingHandoffsContract } from "@okouai/api-contracts/contracts/marketing-handoffs";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { setupPage, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { accountModels } from "./chat-account-model-fixture.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { textContinuityDraft } from "./chat-continuity-test-helpers.ts";

const context = testContext();
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
