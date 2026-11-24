import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { within } from "@testing-library/react";

import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

import {
  openTemplateRecommendations,
  createTemplateGalleryHelpers,
  expectInlineTemplate,
} from "./chat-composer-template-gallery-test-helpers.ts";

const context = testContext();
const { mockTemplateChat } = createTemplateGalleryHelpers(context);

test("chat-composer-template-tabs-001 picks a built-in deck while the custom catalog is pending", async () => {
  mockTemplateChat();
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(userTemplatesContract.list, async ({ respond }) => {
    started.resolve();
    await release.promise;
    return respond(200, []);
  });
  try {
    await setupPage({ context, path: "/" });
    const shelf = await openTemplateRecommendations("Presentation");
    await started.promise;
    const deck = await within(shelf).findByText("Paper magazine");
    expect(deck).toBeEnabled();
    click(deck);
    await expectInlineTemplate("Paper magazine");
  } finally {
    release.resolve();
  }
});
