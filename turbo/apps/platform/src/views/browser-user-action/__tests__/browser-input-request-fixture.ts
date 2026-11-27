import {
  browserUserActionsContract,
  type BrowserUserActionResponse,
  type BrowserUserActionApplyRequest,
} from "@okouai/api-contracts/contracts/browser-user-actions";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import { setupPage } from "../../../__tests__/page-helper.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export type Field = BrowserUserActionResponse["fields"][number];
type Values = BrowserUserActionApplyRequest["values"];
type State = BrowserUserActionResponse["state"];
export const threadId = "86500000-0000-4000-8000-000000000001";
const requestToken = "vm0_browser_user_action_" + "c".repeat(43);
export const callbackPrompt = "Continue the invoice review";
export const siteOrigin = "https://invoices.example";

export function browserInputPath() {
  const query = new URLSearchParams({
    threadId,
    callbackPrompt,
  });
  return "/browser/actions/" + requestToken + "?" + query.toString();
}

export function installBrowserRequest(
  context: TestContext,
  fields: Field[],
  initial: Partial<BrowserUserActionResponse> = {},
) {
  const ids = () => {
    return {
      clientEventId: crypto.randomUUID(),
      chatThreadSortEventId: crypto.randomUUID(),
    };
  };
  const record: BrowserUserActionResponse = {
    kind: "input",
    state: "pending",
    completedAt: null,
    fields,
    requestToken,
    threadId,
    siteOrigin,
    callbackIds: { success: ids(), cancellation: ids() },
    ...initial,
  };
  const callback = context.mocks.deferred<{
    prompt: string;
    threadId: string | undefined;
    state: State;
  }>();
  const applied = context.mocks.deferred<Values>();
  function announce() {
    context.mocks.ably.trigger("browserUserActionChanged:" + threadId);
  }
  function transition(state: State) {
    record.state = state;
    record.completedAt = "2026-09-25T09:30:00.000Z";
    announce();
    return record;
  }
  context.mocks.api(browserUserActionsContract.get, ({ respond }) => {
    // A status read carries the stored fingerprint. Preflight inspects live controls.
    const fields = record.fields.map((field) => {
      const { tagName, inputType } = field.control;
      return { ...field, control: { tagName, inputType } };
    });
    return respond(200, { ...record, fields });
  });
  context.mocks.api(browserUserActionsContract.preflight, ({ respond }) => {
    return respond(200, record);
  });
  context.mocks.api(browserUserActionsContract.apply, ({ body, respond }) => {
    applied.resolve(body.values);
    return respond(200, transition("succeeded"));
  });
  context.mocks.api(browserUserActionsContract.cancel, ({ respond }) => {
    return respond(200, transition("cancelled"));
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (typeof body.prompt !== "string") {
      throw new Error("Expected callback chat input");
    }
    callback.resolve({
      prompt: body.prompt,
      threadId: body.threadId,
      state: record.state,
    });
    const receipt =
      record.state === "cancelled"
        ? record.callbackIds.cancellation
        : record.callbackIds.success;
    record.callbackDelivered =
      body.threadId === record.threadId &&
      body.clientEventId === receipt.clientEventId;
    announce();
    return respond(201, { threadId });
  });
  const path = browserInputPath();
  async function open() {
    await setupPage({
      context,
      host: "app.okou.ai",
      path,
    });
  }
  return { open, record, announce, transition, applied, callback };
}
