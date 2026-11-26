import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createMessageExperienceHelpers,
  findFastControl,
} from "./chat-message-experience-test-helpers.ts";

const context = testContext();
const { installMessageExperienceChat } =
  createMessageExperienceHelpers(context);
const deviceId = "b0000000-0000-4000-8000-000000000001";
const runId = "c0000000-0000-4000-8000-000000000001";

function enableRemoteDevices() {
  const feature = { [FeatureSwitchKey.RemoteDevices]: true };
  context.mocks.api(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, { switches: feature, effectiveSwitches: feature });
  });
}

function authorizationLink(actionId: string) {
  const url = new URL(`http://localhost/chats/${context.resourceId}`);
  url.searchParams.set("remoteDeviceApproval", deviceId);
  url.searchParams.set("reason", "Read the build log.");
  url.searchParams.set("actionId", actionId);
  return url.href;
}

test("cancelling one device request leaves its policy alone and a later card approves the exact device", async () => {
  enableRemoteDevices();
  const device = {
    id: deviceId,
    displayName: "Build Mac",
    accessAllowed: false,
    accessExpiresAt: null,
  };
  context.mocks.api(remoteDevicesContract.list, ({ respond }) => {
    return respond(200, { devices: [{ ...device, channels: [] }] });
  });
  const approvals: unknown[] = [];
  context.mocks.api(
    remoteDevicesContract.approve,
    ({ params, body, respond }) => {
      approvals.push({ threadId: params.threadId, body });
      return respond(200, { ...device, accessAllowed: true });
    },
  );
  const first = authorizationLink("a0000000-0000-4000-8000-000000000002");
  const second = authorizationLink("a0000000-0000-4000-8000-000000000003");
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [
      {
        id: "approval-message",
        role: "assistant",
        content: `${first}\n\n${second}`,
        runId,
        seqId: 1,
        createdAt: "2026-11-26T06:00:00Z",
      },
    ],
  });
  await setupPage({ context, path: `/chats/${context.resourceId}` });
  const cards = await screen.findAllByTestId("remote-device-approval-card");
  const [firstCard, secondCard] = cards;
  expect(cards).toHaveLength(2);
  await within(firstCard!).findByText("Allow access to Build Mac?");
  click(await findFastControl("button", "Cancel", firstCard!));
  expect(firstCard).not.toBeInTheDocument();
  expect(approvals).toEqual([]);
  click(await findFastControl("button", "Allow for 1 hour", secondCard!));
  await within(secondCard!).findByText("Device access granted");
  expect(approvals).toEqual([
    { threadId: context.resourceId, body: { deviceId } },
  ]);
});

test("creates an empty device and moves an existing channel from the directory", async () => {
  enableRemoteDevices();
  const channelId = "d0000000-0000-4000-8000-000000000001";
  const emptyDevice = {
    accessAllowed: false,
    accessExpiresAt: null,
    channels: [],
  };
  const channel = {
    kind: "ssh" as const,
    id: channelId,
    displayName: "Build login",
    lastSeenAt: null,
    sshDependencyIds: [],
  };
  const source = {
    ...emptyDevice,
    id: deviceId,
    displayName: "Build Mac",
    channels: [channel],
  };
  let devices = [source];
  context.mocks.api(remoteDevicesContract.list, ({ respond }) => {
    return respond(200, { devices });
  });
  const createdIds: string[] = [];
  context.mocks.api(remoteDevicesContract.create, ({ body, respond }) => {
    createdIds.push(body.id);
    const device = { ...emptyDevice, ...body };
    devices = [...devices, device];
    return respond(201, device);
  });
  const moves: unknown[] = [];
  context.mocks.api(
    remoteDevicesContract.moveChannel,
    ({ params, respond }) => {
      moves.push({
        channelId: params.channelId,
        deviceId: params.deviceId,
        kind: params.kind,
      });
      devices = devices.map((device) => {
        return {
          ...device,
          channels: device.id === params.deviceId ? [channel] : [],
        };
      });
      return respond(204);
    },
  );
  await setupPage({ context, path: "/connectors?scope=remote-control" });
  const user = userEvent.setup({ delay: null });
  click(await findFastControl("button", "Add device"));
  const createDialog = await screen.findByRole("dialog", {
    name: "Add device",
  });
  await user.type(
    within(createDialog).getByRole("textbox", { name: "Device name" }),
    "Personal Mac",
  );
  click(await findFastControl("button", "Create device", createDialog));
  await findFastControl("link", "Personal Mac");
  click(await findFastControl("link", "Build Mac"));
  click(await findFastControl("button", "Move Build login to another device"));
  click(
    await screen.findByText("Personal Mac", { selector: "[role=menuitem]" }),
  );
  await screen.findByText("No channels");
  expect(moves).toEqual([{ channelId, deviceId: createdIds[0], kind: "ssh" }]);
});

test("the exact approval link opens an owner confirmation without a transcript card", async () => {
  enableRemoteDevices();
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [],
  });
  context.mocks.api(remoteDevicesContract.list, ({ respond }) => {
    return respond(200, {
      devices: [
        {
          id: deviceId,
          displayName: "Build Mac",
          accessAllowed: false,
          accessExpiresAt: null,
          channels: [],
        },
      ],
    });
  });
  const url = new URL(
    authorizationLink("a0000000-0000-4000-8000-000000000004"),
  );
  await setupPage({ context, path: `${url.pathname}${url.search}` });
  const dialog = await screen.findByRole("dialog", {
    name: "Remote device access",
  });
  await within(dialog).findByText("Allow access to Build Mac?");
  click(await findFastControl("button", "Cancel", dialog));
  expect(dialog).not.toBeInTheDocument();
  expect(window.location.search).toBe("");
});
