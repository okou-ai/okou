import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createTemplateGalleryHelpers,
  openTemplatePicker,
  sendComposerMessage,
} from "./chat-composer-template-gallery-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
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
  const menu = await openTemplatePicker(userEvent.setup(), "Image");
  await within(menu).findByText("Image generation is off for you");
  click(await findFastControl("tab", "Website", menu));
  await expect(
    findFastControl("tab", "Website", menu),
  ).resolves.toHaveAttribute("aria-selected", "true");
  await waitFor(() => {
    expect(within(menu).queryByText(/is off for you/)).toBeNull();
    expect(
      queryFastControl("button", "Select website template Coastal Hotel", menu),
    ).toBeEnabled();
  });
});

test("An image prompt reaches the new conversation after the disabled tool is enabled in settings", async () => {
  const saving = context.mocks.deferred<void>();
  const confirm = context.mocks.deferred<void>();
  preferences(async () => {
    saving.resolve();
    await confirm.promise;
  });
  const user = userEvent.setup();
  const chat = createTemplateGalleryHelpers(context).mockTemplateChat();
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
  click(await findFastControl("button", "Add"));
  click(await screen.findByText("Add style"));
  const gallery = await screen.findByRole("dialog");
  await within(gallery).findAllByLabelText(/^Select template /);
  await user.keyboard("{Escape}");
  expect(screen.queryByText("Image generation is off for you")).toBeNull();
  const prompt = "Illustrate an observatory under a violet sky.";
  await sendComposerMessage(user, prompt);
  await waitFor(() => {
    expect(chat.runPrompts).toContainEqual(expect.stringContaining(prompt));
  });
  expect(
    await screen.findByText(prompt, { selector: "[data-role=user] *" }),
  ).toBeVisible();
});
