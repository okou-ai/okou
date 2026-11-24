import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createTemplateGalleryHelpers,
  openTemplateRecommendations,
  expectInlineTemplate,
  sendComposerMessage,
  templatePart,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

test("Select and send a website template", async () => {
  const chat = mockTemplateChat();
  context.mocks.api(userTemplatesContract.list, ({ respond }) => {
    return respond(200, []);
  });
  const website = WEBSITE_TEMPLATE_ITEMS[1];
  if (!website) {
    throw new Error("Expected a built-in website template");
  }
  await setupPage({
    context,
    path: "/",
  });
  const picker = await openTemplateRecommendations("Website");
  const user = userEvent.setup({ delay: null });

  click(within(picker).getByLabelText(`Use template ${website.title}`));

  await expectInlineTemplate(website.title);
  await sendComposerMessage(user, "Build this launch site");
  const sent = await waitFor(() => {
    const message = chat.sentMessages.at(-1);
    expect(message).toBeDefined();
    return message;
  });
  expect(sent && templatePart(sent).template).toStrictEqual({
    type: "website",
    selection: { websiteTemplateId: website.id },
  });
  expect(
    sent?.parts.some((part) => {
      return (
        part.type === "text" && part.text.includes("Build this launch site")
      );
    }),
  ).toBeTruthy();
});
