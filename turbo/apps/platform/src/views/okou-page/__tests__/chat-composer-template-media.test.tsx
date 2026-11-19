import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  AGENT_ID,
  createTemplateGalleryHelpers,
  expectInlineTemplate,
  sendComposerMessage,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";
import { CLAUDE_SUBSCRIPTION_PROVIDER_ID } from "./chat-composer-test-helpers.ts";
import { buildRunModel } from "./chat-model-builders.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

test("Select and send a website template", async () => {
  const capture = mockTemplateChat();
  context.mocks.data.availableRunModels([
    buildRunModel({
      model: "claude-sonnet-5",
      modelProviderId: CLAUDE_SUBSCRIPTION_PROVIDER_ID,
    }),
  ]);
  const template = WEBSITE_TEMPLATE_ITEMS[0];
  if (!template) {
    throw new Error("Website template fixture not found");
  }
  const user = userEvent.setup({ delay: null });
  await setupPage({
    context,
    path: `/agents/${AGENT_ID}/chat?templatePicker=website`,
    host: "app.okou.ai",
  });
  const picker = await screen.findByRole("dialog");

  click(
    within(picker).getByLabelText(`Select website template ${template.title}`),
  );

  await expectInlineTemplate(template.title);
  await sendComposerMessage(user, "Build this launch site");
  const sent = await waitFor(() => {
    const [message] = capture.sentMessages;
    expect(message).toBeDefined();
    return message;
  });
  if (!sent) {
    throw new Error("Expected the website template message");
  }
  expect(templatePart(sent).template).toStrictEqual({
    type: "website",
    selection: { websiteTemplateId: template.id },
  });
});
