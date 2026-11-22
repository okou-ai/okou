import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";
import { findComposerEditor } from "./chat-composer-test-helpers.ts";
const context = testContext();
type Fixture = NonNullable<Parameters<typeof mockChatLifecycle>[1]>;
type Sent = Parameters<NonNullable<Fixture["onSendRequest"]>>[0];
type Created = Parameters<NonNullable<Fixture["onThreadCreate"]>>[0];
function conversation() {
  const sent: Sent[] = [];
  const created: Created[] = [];
  mockChatLifecycle(context, {
    onSendRequest(body) {
      sent.push(body);
    },
    onThreadCreate(body) {
      created.push(body);
    },
  });
  return { sent, created };
}
test("prompt-link-002 Opening a Home prompt link prefills an editable draft without sending it", async () => {
  const prompt = "Outline the customer interview";
  const suffix = " questions";
  const requests = conversation();
  await setupPage({
    context,
    path: "/?" + new URLSearchParams({ prompt }).toString(),
  });
  const composer = await findComposerEditor();
  await waitFor(() => {
    expect(composer).toHaveTextContent(prompt);
  });
  composer.focus();
  const user = userEvent.setup({ delay: null });
  {
    const selection = window.getSelection();
    selection?.selectAllChildren(composer);
    selection?.collapseToEnd();
    await user.paste(suffix);
  }
  expect(composer.textContent).toBe(prompt + suffix);
  expect(location.pathname).toBe("/");
  expect(location.search).toBe("");
  expect(requests.sent).toStrictEqual([]);
  expect(requests.created).toStrictEqual([]);
});
test.each([
  [
    "prompt-link-009",
    "cozy-parlor",
    "Cozy Parlor",
    {
      type: "illustration",
      selection: { illustrationStyleId: "image-style:cozy-parlor" },
    },
  ],
  [
    "prompt-link-010",
    "playful-launch-presentation",
    "Sunburst playroom",
    {
      type: "presentation",
      selection: {
        templateId: "template:html-ppt-playful-launch",
        colorSystemId: "color-system:carnival",
        previewUrl: expect.stringMatching(/playful-launch-presentation\.html$/),
      },
    },
  ],
  [
    "prompt-link-012",
    "website-template:black-slabs",
    "Black Slabs",
    {
      type: "website",
      selection: { websiteTemplateId: "website-template:black-slabs" },
    },
  ],
] as const)(
  "%s A prompt link sends the selected %s template snapshot to its new conversation",
  async (_id, template, title, expected) => {
    const captured = conversation();
    const prompt = "Prepare the launch materials";
    await setupPage({
      context,
      path: "/prompt?" + new URLSearchParams({ prompt, template }).toString(),
    });
    await waitFor(() => {
      expect(location.pathname).toMatch(/^\/chats\//);
    });
    await waitFor(() => {
      expect(captured.sent.at(-1)?.userMessage?.parts).toContainEqual({
        type: "template",
        titleSnapshot: title,
        template: expected,
      });
    });
    const message = await screen.findByText(prompt, { exact: true });
    expect(message).toBeVisible();
    expect(location.search).toBe("");
    expect(captured.created.at(-1)?.modelSelection).toBeNull();
    expect(
      captured.sent.at(-1)?.userMessage?.parts.filter((part) => {
        return part.type === "model";
      }),
    ).toStrictEqual([]);
  },
);
