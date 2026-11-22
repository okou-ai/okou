import { paidToolsContract } from "@okouai/api-contracts/contracts/paid-tools";
import { waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { openTemplatePicker } from "./chat-composer-template-gallery-test-helpers.ts";
import {
  findFastControl,
  queryFastControl,
} from "./chat-message-experience-test-helpers.ts";
const context = testContext();
function preferences() {
  let disabled = true;
  context.mocks.api(paidToolsContract.get, ({ respond }) => {
    return respond(200, {
      disabledTools: disabled ? ["image-generation"] : [],
    });
  });
  context.mocks.api(paidToolsContract.update, ({ params, body, respond }) => {
    expect(params.toolId).toBe("image-generation");
    disabled = body.disabled;
    return respond(200, { toolId: params.toolId, disabled });
  });
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
