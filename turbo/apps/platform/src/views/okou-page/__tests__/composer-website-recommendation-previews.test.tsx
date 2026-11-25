import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { findAction } from "./connector-integrations-test-helpers.ts";
import userEvent from "@testing-library/user-event";
import { captureTemplateSubmission } from "./template-submission-fixtures.ts";
import { WEBSITE_TEMPLATE_ITEMS } from "@okouai/core/website-template-items";
const context = testContext();

const site = WEBSITE_TEMPLATE_ITEMS[0];
async function website() {
  const sent = captureTemplateSubmission(context);
  await setupPage({ context, path: "/", host: "app.okou.ai" });
  click(await findAction("button", "Website"));
  const editor = await screen.findByLabelText("Message");
  await fill(editor, "Build a field journal");
  return { editor, sent };
}
test("composer-website-recommendation-previews-003 closing a website preview leaves the cover available to attach and send", async () => {
  const { editor, sent } = await website();
  await userEvent.click(
    await findAction("button", "Preview template " + site.title),
  );
  const modal = await screen.findByRole("dialog");
  await waitFor(() => {
    return expect(modal.querySelector("iframe")).toHaveAttribute(
      "src",
      site.previewUrl,
    );
  });
  click(await findAction("button", "Close", modal));
  click(await findAction("button", site.title));
  await waitFor(() => {
    return expect(editor).toHaveTextContent(site.title);
  });
  expect(editor).toHaveTextContent("Build a field journal");
  click(await findAction("button", "Send"));
  const parts = (await sent.promise).userMessage?.parts;
  expect(parts).toContainEqual({ type: "text", text: "Build a field journal" });
  expect(parts).toContainEqual(
    expect.objectContaining({
      type: "template",
      template: { type: "website", selection: { websiteTemplateId: site.id } },
    }),
  );
});
test("composer-website-recommendation-previews-004 the sandboxed website preview returns focus to its recommendation", async () => {
  const { editor, sent } = await website();
  const eye = await findAction("button", "Preview template " + site.title);
  await userEvent.click(eye);
  const direct = await screen.findByRole("dialog");
  const frame = direct.querySelector("iframe");
  expect(frame).toHaveAttribute("src", site.previewUrl);
  expect(frame).toHaveAttribute("sandbox");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(eye).toHaveFocus();
  });
  expect(editor).toHaveTextContent(/^Build a field journal$/);
  expect(sent.settled()).toBeFalsy();
});
