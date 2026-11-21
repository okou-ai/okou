import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  browserInputPath,
  callbackPrompt,
  installBrowserRequest,
  threadId,
  type Field,
} from "../../browser-user-action/__tests__/browser-input-request-fixture.ts";
import { AGENT_ID } from "./chat-lifecycle-test-helpers.ts";
import {
  assistantEvent,
  completedEvent,
  createChatRunFixtures,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const path = browserInputPath(AGENT_ID);
async function openConversation(fields: Field[], messages: string[]) {
  const chatEvents = messages.flatMap((text, index) => {
    const runId = crypto.randomUUID();
    const seqId = index * 2 + 1;
    return [
      assistantEvent({ id: "invoice-request-" + index, runId, seqId, text }),
      completedEvent({
        id: "invoice-completion-" + index,
        runId,
        seqId: seqId + 1,
      }),
    ];
  });
  createChatRunFixtures(context).installRunChat({ threadId, chatEvents });
  const request = installBrowserRequest(context, fields, { agentId: AGENT_ID });
  await setupPage({ context, host: "app.okou.ai", path: "/chats/" + threadId });
  return request;
}

test("chat-capability-browser-actions-012 selecting a local appointment continues the chat with the exact wall-clock time", async () => {
  const appointment: Field = {
    key: "appointment",
    label: "Pickup appointment",
    fieldKind: "date_time",
    required: true,
    control: {
      tagName: "INPUT",
      inputType: "datetime-local",
      min: "2026-09-01T00:00",
      max: "2026-09-30T23:59",
      step: "60",
    },
  };
  const request = await openConversation(
    [appointment],
    ["https://app.okou.ai" + path],
  );
  click(await screen.findByText("Enter information", { selector: "button" }));
  const dialog = within(await screen.findByRole("dialog"));
  const input = dialog.getByLabelText(appointment.label, {
    selector: 'input[type="datetime-local"]',
  });
  await waitFor(() => {
    expect(input).toHaveAttribute("step", "60");
  });
  const value = "2026-09-25T09:30";
  fireEvent.change(input, { target: { value } });
  click(dialog.getByText("Add to browser", { selector: "button" }));
  await screen.findByText("Agent notified");
  await expect(request.applied.promise).resolves.toStrictEqual([
    { key: "appointment", value },
  ]);
  await expect(request.callback.promise).resolves.toMatchObject({
    prompt: callbackPrompt,
    threadId,
  });
});

test("chat-capability-browser-actions-025 absolute and relative account URLs render as buttons in the conversation", async () => {
  const absolute = "https://app.okou.ai" + path;
  const field: Field = {
    key: "account",
    label: "Account email",
    fieldKind: "username",
    required: true,
    control: { tagName: "INPUT", inputType: "email" },
  };
  await openConversation([field], [absolute, path]);
  await waitFor(() => {
    expect(
      screen.getAllByText("Enter information", { selector: "button" }),
    ).toHaveLength(2);
  });
  const routeLinks = queryAllByRoleFast("link").filter((element) => {
    return (
      element.getAttribute("href") === absolute ||
      element.getAttribute("href") === path
    );
  });
  expect(routeLinks).toStrictEqual([]);
  const [first] = screen.getAllByText("Enter information", {
    selector: "button",
  });
  click(first!);
  const dialog = within(await screen.findByRole("dialog"));
  expect(dialog.getByLabelText("Account email")).toBeInTheDocument();
});
