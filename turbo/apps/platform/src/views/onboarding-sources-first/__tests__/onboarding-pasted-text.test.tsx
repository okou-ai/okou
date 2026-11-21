import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  marketingHandoffsContract,
  type MarketingHandoffManifest,
} from "@okouai/api-contracts/contracts/marketing-handoffs";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
const context = testContext();
const hash = "a".repeat(64);
const task = "Keep this draft. ";
async function openEditor(text: string) {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    path: "/onboarding?" + new URLSearchParams({ prompt: text }),
  });
  return screen.findByLabelText("Onboarding prompt");
}
test("onboarding-pasted-text-005 the full pasted document travels through the handoff into the first sent message", async () => {
  const text = "abcde".repeat(5000);
  const original = "Reply with only the number 5.";
  let manifest: MarketingHandoffManifest | undefined;
  const user = userEvent.setup();
  const sent = context.mocks.deferred<{
    threadId: string;
    prompt: unknown;
    parts: unknown;
  }>();
  const uploaded = context.mocks.deferred<string>();
  const saved = context.mocks.deferred<MarketingHandoffManifest>();
  context.mocks.api(marketingHandoffsContract.upload, ({ body, respond }) => {
    if (!uploaded.settled()) {
      uploaded.resolve(atob(body.data));
    }
    return respond(200, {
      hash,
      filename: body.filename,
      contentType: body.contentType,
      size: text.length,
    });
  });
  context.mocks.api(marketingHandoffsContract.create, ({ body, respond }) => {
    manifest = body;
    if (!saved.settled()) {
      saved.resolve(body);
    }
    return respond(200, { hash, shortHash: hash.slice(0, 12) });
  });
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    if (!manifest) {
      throw new Error("No stored handoff");
    }
    return respond(200, manifest);
  });
  context.mocks.api(marketingHandoffsContract.import, ({ respond }) => {
    if (!manifest) {
      throw new Error("No stored file");
    }
    return respond(200, {
      files: manifest.files.map((f) => {
        return {
          ...f,
          id: "f0000000-0000-4000-a000-000000000001",
          url: "https://cdn.okou.io/artifacts/onboarding/pasted.txt",
        };
      }),
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (!body.threadId) {
      throw new Error("Missing chat destination");
    }
    if (!sent.settled()) {
      sent.resolve({
        threadId: body.threadId,
        prompt: body.prompt,
        parts: body.userMessage?.parts,
      });
    }
    return respond(201, {
      threadId: body.threadId,
      createdAt: "2026-11-01T00:00:00Z",
    });
  });
  const editor = await openEditor(original);
  await user.click(editor);
  await user.paste(text);
  await expect(uploaded.promise).resolves.toBe(text);
  const file = await screen.findByText(/pasted.text-1\.txt/i);
  const filename = file.textContent;
  if (!filename) {
    throw new Error("Missing uploaded filename");
  }
  await waitFor(() => {
    return expect(getAction("button", "Next")).toBeEnabled();
  });
  click(getAction("button", "Next"));
  await expect(saved.promise).resolves.toMatchObject({
    prompt: original,
    files: [{ hash, filename, contentType: "text/plain", size: 25_000 }],
  });
  const submitted = await sent.promise;
  expect(submitted.prompt).toBe(original);
  expect(submitted.parts).toContainEqual(
    expect.objectContaining({
      type: "file",
      filenameSnapshot: filename,
      fileId: "f0000000-0000-4000-a000-000000000001",
    }),
  );
  await expect(screen.findByText(original)).resolves.toBeVisible();
  await expect(screen.findByText(filename)).resolves.toBeVisible();
  expect(location.pathname).toBe("/chats/" + submitted.threadId);
  expect(new URL(location.href).searchParams.has("handoff")).toBeFalsy();
});
test("onboarding-pasted-text-007 retries exactly the retained text and removes either a successful or a failed paste", async () => {
  const user = userEvent.setup();
  const text = "unsubmitted data ".repeat(900);
  let available = false;
  const retry = context.mocks.deferred<string>();
  context.mocks.api(marketingHandoffsContract.upload, ({ body, respond }) => {
    if (!available) {
      return respond(503, {
        error: { code: "PROVIDER_UNAVAILABLE", message: "Upload unavailable" },
      });
    }
    if (!retry.settled()) {
      retry.resolve(atob(body.data));
    }
    return respond(200, {
      filename: body.filename,
      hash,
      size: text.length,
      contentType: body.contentType,
    });
  });
  const editor = await openEditor("Review the workbook.");
  await user.click(editor);
  await user.paste(text);
  await screen.findByText(/Could not upload/);
  expect(getAction("button", "Next")).toBeDisabled();
  available = true;
  click(await findAction("button", "Retry"));
  await expect(retry.promise).resolves.toBe(text);
  await waitFor(() => {
    return expect(getAction("button", "Next")).toBeEnabled();
  });
  click(getAction("button", "Remove Pasted text-1.txt"));
  expect(
    queryAction("button", "Remove Pasted text-1.txt"),
  ).not.toBeInTheDocument();
  expect(editor).toHaveValue("Review the workbook.");
  expect(getAction("button", "Next")).toBeEnabled();
  available = false;
  await user.click(editor);
  await user.paste(text);
  await screen.findByText(/Could not upload/);
  click(getAction("button", "Remove Pasted text-2.txt"));
  expect(screen.queryByText(/Could not upload/)).not.toBeInTheDocument();
  expect(
    queryAction("button", "Remove Pasted text-2.txt"),
  ).not.toBeInTheDocument();
  expect(editor).toHaveValue("Review the workbook.");
  expect(getAction("button", "Next")).toBeEnabled();
});
test("onboarding-pasted-text-008 mixed image and text clipboard keeps the oversized text inline", async () => {
  const user = userEvent.setup();
  const editor = await openEditor(task);
  await user.click(editor);
  const data = new DataTransfer();
  const content = "b".repeat(10_001);
  data.setData("text/plain", content);
  data.items.add(new File(["local pixels"], "scan.png", { type: "image/png" }));
  await user.paste(data);
  expect(editor).toHaveValue(task + content);
  expect(getAction("button", "Next")).toBeEnabled();
  expect(
    screen.queryByRole("list", { name: "Attachments" }),
  ).not.toBeInTheDocument();
});
