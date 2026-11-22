import {
  phoneUseContract,
  type PhoneDevice,
  type PhoneUseSelection,
} from "@okouai/api-contracts/contracts/phone-use";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findComposer,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";
import { RUN_PATH, RUN_THREAD_ID } from "./chat-run-test-fixtures.ts";
import { mockChatLifecycle } from "./chat-test-helpers.ts";

const context = testContext();

function device(name: string, online = true): PhoneDevice {
  return {
    id: crypto.randomUUID(),
    displayName: name,
    online,
    osVersion: "27.0",
    appVersion: "1",
    generation: 1,
    lastSeenAt: "2026-11-01T10:00:00.000Z",
  };
}
async function visit(
  devices: PhoneDevice[],
  opts: {
    selected?: PhoneDevice;
    newChat?: boolean;
    deny?: boolean;
    hold?: Promise<void>;
    onList?: () => void;
  } = {},
) {
  let selection: PhoneUseSelection | null = opts.selected
    ? { deviceId: opts.selected.id, generation: 1 }
    : null;
  const started = context.mocks.deferred<string>();
  const authorized = context.mocks.deferred<void>();
  mockChatLifecycle(context, {
    threadId: RUN_THREAD_ID,
    onSendRequest(body) {
      started.resolve(body.prompt ?? "");
    },
  });
  context.mocks.api(phoneUseContract.devices, ({ respond }) => {
    opts.onList?.();
    return respond(200, { devices });
  });
  context.mocks.api(phoneUseContract.chatGrant, ({ respond }) => {
    return respond(200, { selection });
  });
  context.mocks.api(phoneUseContract.grant, async ({ body, respond }) => {
    authorized.resolve();
    await opts.hold;
    if (opts.deny) {
      return respond(403, {
        error: {
          message: "Phone access could not be saved",
          code: "FORBIDDEN",
        },
      });
    }
    selection = body.allow
      ? { deviceId: body.deviceId, generation: body.generation }
      : null;
    return respond(200, { ok: true });
  });
  await setupPage({
    context,
    path: opts.newChat ? "/" : RUN_PATH,
    featureSwitches: { [FeatureSwitchKey.PhoneUse]: true },
  });
  const trigger = await findFastControl("button", "Connectors");
  click(trigger);
  return { trigger, started, authorized };
}
function phoneSwitch(name: string) {
  return screen.findByRole("switch", { name });
}
test("chat-capability-phone-use-004 disabling the selected offline phone clears chat access", async () => {
  const old = device("Travel phone", false);
  await visit([old], { selected: old });
  const switcher = await phoneSwitch(old.displayName + " Offline");
  expect(switcher).toBeChecked();
  expect(switcher).toBeEnabled();
  expect(switcher.closest("label")).toHaveTextContent("Offline");
  click(switcher);
  await screen.findByText("No phones online");
  expect(screen.queryByText(old.displayName)).toBeNull();
});
test("chat-capability-phone-use-006 phone setup explains the three steps and Escape restores the connector trigger", async () => {
  const { trigger } = await visit([]);
  click(await screen.findByText("Connect my phone"));
  const dialog = await screen.findByRole("dialog", {
    name: "Connect my phone",
  });
  for (const instruction of [
    "Open Okou iOS Use",
    "Enable your phone in this chat",
    "Send your next task",
  ]) {
    expect(within(dialog).getByText(instruction)).toBeInTheDocument();
  }
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    expect(dialog).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
test("chat-capability-phone-use-009 the first Run starts after the selected phone grant is saved", async () => {
  const gate = context.mocks.deferred<void>();
  const { started, authorized } = await visit([device("Kitchen")], {
    newChat: true,
    hold: gate.promise,
  });
  click(await phoneSwitch("Kitchen"));
  await userEvent.keyboard("{Escape}");
  await fill(await findComposer(), "Use my phone");
  click(await findFastControl("button", "Send"));
  await authorized.promise;
  expect(started.settled()).toBeFalsy();
  gate.resolve();
  await expect(started.promise).resolves.toBe("Use my phone");
});
test("chat-capability-phone-use-011 denied phone access keeps the unsent task and pending selection", async () => {
  const { started, trigger } = await visit([device("Kitchen")], {
    newChat: true,
    deny: true,
  });
  click(await phoneSwitch("Kitchen"));
  await userEvent.keyboard("{Escape}");
  const editor = await findComposer();
  await fill(editor, "Use my phone");
  click(await findFastControl("button", "Send"));
  await screen.findByText("Phone access could not be saved");
  expect(location.pathname).toBe("/");
  expect(editor).toHaveTextContent("Use my phone");
  expect(started.settled()).toBeFalsy();
  click(trigger);
  await expect(phoneSwitch("Kitchen")).resolves.toBeChecked();
});
test("chat-capability-phone-use-002 phone availability changes between connector menus", async () => {
  const phones = [device("Kitchen"), device("Entry", false)];
  let closing = false;
  const closingRead = context.mocks.deferred<void>();
  const { trigger } = await visit(phones, {
    onList() {
      if (closing) {
        closingRead.resolve();
      }
    },
  });
  await phoneSwitch("Kitchen");
  expect(screen.queryByText("Entry")).toBeNull();
  closing = true;
  await userEvent.keyboard("{Escape}");
  await waitFor(() => {
    return expect(screen.queryByText("Kitchen")).toBeNull();
  });
  phones[0]!.online = false;
  closing = false;
  click(trigger);
  await screen.findByText("No phones online");
  expect(closingRead.settled()).toBeFalsy();
});
