import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { findAction } from "./connector-integrations-test-helpers.ts";
import { captureTemplateSubmission } from "./template-submission-fixtures.ts";

const context = testContext();

async function draft() {
  const sent = captureTemplateSubmission(context);
  await setupPage({ context, path: "/" });
  const editor = await screen.findByLabelText("Message");
  await fill(editor, "Our launch");
  click(await findAction("button", "Presentation"));
  return { sent, editor };
}
test("chat-composer-presentation-options-001 the launch brief survives opening the presentation shelf", async () => {
  const { editor } = await draft();
  await screen.findByRole("group", { name: "Presentation templates" });
  expect(editor).toHaveTextContent(/^Our launch$/);
});
test("chat-composer-presentation-options-004 a slide range is sent alongside the unchanged launch brief", async () => {
  const { sent } = await draft();
  click(await screen.findByLabelText("Slide count"));
  click(await screen.findByText("20–24 slides"));
  click(await findAction("button", "Send"));
  const { userMessage } = await sent.promise;
  expect(userMessage?.parts).toContainEqual({
    type: "text",
    text: "Our launch",
  });
  expect(
    userMessage?.parts.find((p) => {
      return p.type === "additional_info";
    })?.text,
  ).toMatch(
    /Slide count: 20-24[\s\S]*different .*slide count, the message wins/i,
  );
});
test("chat-composer-presentation-options-005 removing presentation discards the Auto preference before sending", async () => {
  const { sent } = await draft();
  await screen.findByRole("group", { name: "Presentation templates" });
  click(await screen.findByLabelText("Slide count"));
  click(await screen.findByText("Auto"));
  click(await findAction("button", "Remove Presentation"));
  await waitFor(() => {
    return expect(
      screen.queryByRole("group", { name: "Presentation templates" }),
    ).toBeNull();
  });
  click(await findAction("button", "Send"));
  expect((await sent.promise).userMessage?.parts).toStrictEqual([
    { type: "text", text: "Our launch" },
  ]);
});
