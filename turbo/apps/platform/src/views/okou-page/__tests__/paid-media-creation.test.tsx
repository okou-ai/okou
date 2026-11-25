import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createTemplateGalleryHelpers,
  sendComposerMessage,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
function preferences(beforeSave?: () => Promise<void>) {
  let disabled = true;
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, {
      disabledTools: disabled ? ["image-generation"] : [],
    });
  });
  context.mocks.api(
    paidToolsContract.update,
    async ({ params, body, respond }) => {
      expect(params.toolId).toBe("image-generation");
      await beforeSave?.();
      disabled = body.disabled;
      return respond(200, { toolId: params.toolId, disabled });
    },
  );
}
test("paid-media-creation-004 the disabled image category leaves Website templates available", async () => {
  preferences();
  await setupPage({ context, path: "/" });
  click(await findFastControl("button", "Image"));
  await screen.findByText("Image generation is off for you");
  const types = await screen.findByRole("radiogroup", { name: "Create" });
  click(await within(types).findByText("Website"));
  const shelf = await screen.findByRole("group", { name: "Website templates" });
  expect(screen.queryByText("Image generation is off for you")).toBeNull();
  await expect(
    findFastControl("button", /^Use template /, shelf),
  ).resolves.toBeEnabled();
});

test("An image prompt reaches the new conversation after the disabled tool is enabled in settings", async () => {
  const saving = context.mocks.deferred<void>();
  const confirm = context.mocks.deferred<void>();
  preferences(async () => {
    saving.resolve();
    await confirm.promise;
  });
  const user = userEvent.setup();
  const submissions = new Set<string>();
  const chat = createTemplateGalleryHelpers(context).mockTemplateChat({
    onSendRequest({ clientThreadId, threadId, clientEventId }) {
      if (!clientEventId) {
        throw new Error("Missing image prompt identity");
      }
      submissions.add(
        JSON.stringify([clientThreadId ?? threadId, clientEventId]),
      );
    },
  });
  await setupPage({ context, path: "/" });
  click(await findFastControl("button", "Image"));
  await screen.findByText("Image generation is off for you");
  click(await findFastControl("button", "Open settings"));
  const settings = await screen.findByRole("dialog");
  const image = await within(settings).findByRole("switch", {
    name: "Image generation",
  });
  expect(image).not.toBeChecked();
  click(image);
  await saving.promise;
  confirm.resolve();
  await waitFor(() => {
    expect(image).toBeChecked();
    expect(image).toBeEnabled();
  });
  click(await findFastControl("button", "Close", settings));
  await waitFor(() => {
    expect(settings).not.toBeInTheDocument();
    expect(screen.queryByText("Image generation is off for you")).toBeNull();
  });
  await expect(
    findFastControl("button", "Remove Image"),
  ).resolves.toBeEnabled();
  const shelf = await screen.findByRole("group", { name: "Image styles" });
  await expect(
    findFastControl("button", /^Use template /, shelf),
  ).resolves.toBeEnabled();
  expect(screen.queryByText("Image generation is off for you")).toBeNull();
  const prompt = "Illustrate an observatory under a violet sky.";
  await sendComposerMessage(user, prompt);
  await waitFor(() => {
    expect(chat.runPrompts).toContainEqual(expect.stringContaining(prompt));
  });
  await expect(
    screen.findByText(prompt, { selector: "[data-role=user] *" }),
  ).resolves.toBeVisible();
  chat.lifecycle.completeRun("Observatory illustration ready");
  await screen.findByText("Observatory illustration ready");
  expect(submissions.size).toBe(1);
});
