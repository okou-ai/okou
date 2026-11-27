import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { remoteDevicesContract } from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { mockNow, now } from "../../../lib/time.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
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
  expect(approvals).toStrictEqual([]);
  click(await findFastControl("button", "Allow for 1 hour", secondCard!));
  await within(secondCard!).findByText("Device access granted");
  expect(approvals).toStrictEqual([
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
  await screen.findByText("Computer use");
  click(await findFastControl("button", "Create empty device"));
  const createDialog = await screen.findByRole("dialog", {
    name: "Create empty device",
  });
  await user.type(
    within(createDialog).getByRole("textbox", { name: "Device name" }),
    "Personal Mac",
  );
  click(await findFastControl("button", "Create device", createDialog));
  await screen.findByRole("heading", { name: "Personal Mac" });
  click(await findFastControl("button", "Add channel"));
  await screen.findByRole("heading", { name: "Add a channel to Personal Mac" });
  expect(screen.getByText("SSH")).toBeInTheDocument();
  expect(screen.getByText("VNC")).toBeInTheDocument();
  expect(screen.queryByText("Computer use")).not.toBeInTheDocument();
  click(await findFastControl("button", "Back"));
  await screen.findByRole("heading", { name: "Personal Mac" });
  click(await findFastControl("link", "Remote devices"));
  click(await findFastControl("link", "Build Mac"));
  click(await findFastControl("button", "Move Build login to another device"));
  const destinations = await screen.findByRole("menu");
  expect(within(destinations).getByText("Off")).toBeInTheDocument();
  click(within(destinations).getByText("Personal Mac"));
  await screen.findByText("No channels");
  expect(moves).toStrictEqual([
    { channelId, deviceId: createdIds[0], kind: "ssh" },
  ]);
  click(await findFastControl("radio", "Connected"));
  click(await findFastControl("radio", /^Remote devices/));
  await findFastControl("button", "Add device");
  expect(
    screen.queryByRole("heading", { name: "Channels" }),
  ).not.toBeInTheDocument();
});

test("renames a device from the detail header and retains the draft after a failed save", async () => {
  enableRemoteDevices();
  let device = {
    id: deviceId,
    displayName: "Build Mac",
    accessAllowed: false,
    accessExpiresAt: null,
    channels: [],
  };
  context.mocks.api(remoteDevicesContract.list, ({ respond }) => {
    return respond(200, { devices: [device] });
  });
  const rejectFirstSave = createDeferredPromise<void>(context.signal);
  let attempts = 0;
  context.mocks.api(
    remoteDevicesContract.rename,
    async ({ params, body, respond }) => {
      expect(params.deviceId).toBe(deviceId);
      expect(body.displayName).toBe("Studio Mac");
      if (++attempts === 1) {
        await rejectFirstSave.promise;
        return respond(400, {
          error: {
            code: "BAD_REQUEST",
            message: "Device name could not be saved",
          },
        });
      }
      device = { ...device, displayName: body.displayName };
      return respond(200, device);
    },
  );
  await setupPage({
    context,
    path: `/connectors?scope=remote-control&remoteDevice=${deviceId}`,
  });
  const user = userEvent.setup({ delay: null });
  const trigger = await findFastControl("button", "Rename");
  trigger.focus();
  await user.keyboard("{Enter}");
  const dialog = await screen.findByRole("dialog", { name: "Rename device" });
  const input = within(dialog).getByRole("textbox", { name: "Device name" });
  const save = await findFastControl("button", "Save", dialog);
  expect(input).toHaveValue("Build Mac");
  await waitFor(() => {
    expect(input).toHaveFocus();
  });
  expect(save).toBeDisabled();
  await fill(input, "  ");
  expect(save).toBeDisabled();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });

  await user.click(trigger);
  const reopened = await screen.findByRole("dialog", { name: "Rename device" });
  const draft = within(reopened).getByRole("textbox", { name: "Device name" });
  const submit = await findFastControl("button", "Save", reopened);
  expect(draft).toHaveValue("Build Mac");
  await fill(draft, "  Studio Mac  ");
  expect(
    fireEvent.keyDown(draft, { key: "Enter", isComposing: true }),
  ).toBeFalsy();
  expect(fireEvent.keyDown(draft, { key: "Enter", keyCode: 229 })).toBeFalsy();
  await user.keyboard("{Enter}");
  await waitFor(() => {
    expect(submit).toHaveAttribute("aria-busy", "true");
  });
  await user.keyboard("{Escape}");
  expect(reopened).toBeVisible();
  rejectFirstSave.resolve();
  await expect(within(reopened).findByRole("alert")).resolves.toHaveTextContent(
    "Could not save the device change.",
  );
  expect(draft).toHaveValue("  Studio Mac  ");
  await user.click(submit);
  await screen.findByRole("heading", { name: "Studio Mac" });
  await waitFor(() => {
    expect(trigger).toHaveFocus();
  });
  click(await findFastControl("link", "Remote devices"));
  await findFastControl("link", "Studio Mac");
});

test("deletes a device from the detail header only after confirming", async () => {
  enableRemoteDevices();
  let devices = [
    {
      id: deviceId,
      displayName: "Build Mac",
      accessAllowed: false,
      accessExpiresAt: null,
      channels: [
        {
          id: "d0000000-0000-4000-8000-000000000001",
          kind: "ssh" as const,
          displayName: "Build login",
          lastSeenAt: null,
          sshDependencyIds: [],
        },
      ],
    },
  ];
  context.mocks.api(remoteDevicesContract.list, ({ respond }) => {
    return respond(200, { devices });
  });
  const deleted: string[] = [];
  context.mocks.api(remoteDevicesContract.delete, ({ params, respond }) => {
    deleted.push(params.deviceId);
    devices = [];
    return respond(204);
  });
  await setupPage({
    context,
    path: `/connectors?scope=remote-control&remoteDevice=${deviceId}`,
  });

  await expect(
    screen.findByRole("group", { name: "Access for Build Mac, Off" }),
  ).resolves.toBeVisible();
  const trigger = await findFastControl("button", "Delete");
  const user = userEvent.setup({ delay: null });
  await user.click(trigger);
  const confirmation = await screen.findByRole("dialog", {
    name: "Delete Build Mac?",
  });
  expect(
    within(confirmation).getByText(
      "This permanently deletes the device and all its channels.",
    ),
  ).toBeVisible();
  await user.click(await findFastControl("button", "Cancel", confirmation));
  await waitFor(() => {
    return expect(confirmation).not.toBeInTheDocument();
  });
  expect(deleted).toStrictEqual([]);

  await user.click(trigger);
  const reopened = await screen.findByRole("dialog", {
    name: "Delete Build Mac?",
  });
  await user.click(await findFastControl("button", "Delete", reopened));
  await waitFor(() => {
    return expect(deleted).toStrictEqual([deviceId]);
  });
  await screen.findByText("No remote devices yet.");
  expect(window.location.search).toBe("?scope=remote-control");
});

test("device access changes after choosing a duration and can be denied from the card", async () => {
  enableRemoteDevices();
  let device = {
    id: deviceId,
    displayName: "Build Mac",
    accessAllowed: false,
    accessExpiresAt: null as string | null,
    channels: [],
  };
  const policies: unknown[] = [];
  context.mocks.api(remoteDevicesContract.list, ({ respond }) => {
    return respond(200, { devices: [device] });
  });
  context.mocks.api(
    remoteDevicesContract.setAccess,
    ({ params, body, respond }) => {
      policies.push({ deviceId: params.deviceId, body });
      const expiresAt =
        body.mode === "for"
          ? new Date(now() + body.hours * 3_600_000).toISOString()
          : null;
      device = {
        ...device,
        accessAllowed: body.mode !== "denied",
        accessExpiresAt: expiresAt,
      };
      return respond(200, device);
    },
  );

  await setupPage({ context, path: "/connectors?scope=remote-control" });
  const denied = await screen.findByRole("group", {
    name: "Access for Build Mac, Off",
  });
  const allow = await findFastControl("button", "Allow", denied);
  const user = userEvent.setup({ delay: null });
  click(allow);
  await screen.findByRole("menu");
  expect(policies).toStrictEqual([]);
  await user.keyboard("{Escape}");
  expect(allow).toHaveFocus();
  click(allow);
  click(
    await within(await screen.findByRole("menu")).findByText("Allow for 1h"),
  );

  const allowed = await screen.findByRole("group", {
    name: "Access for Build Mac, 1h",
  });
  click(await findFastControl("button", "Deny", allowed));
  await screen.findByRole("group", { name: "Access for Build Mac, Off" });
  expect(policies).toStrictEqual([
    { deviceId, body: { mode: "for", hours: 1 } },
    { deviceId, body: { mode: "denied" } },
  ]);
});

test("the visible directory refreshes when a Desktop installation pairs", async () => {
  enableRemoteDevices();
  let paired = false;
  const device = {
    id: deviceId,
    displayName: "Studio Mac",
    accessAllowed: false,
    accessExpiresAt: null,
    channels: [
      {
        id: "d0000000-0000-4000-8000-000000000002",
        kind: "desktop" as const,
        displayName: "Studio Mac",
        lastSeenAt: new Date(now()).toISOString(),
        sshDependencyIds: [],
      },
    ],
  };
  context.mocks.api(remoteDevicesContract.list, ({ respond }) => {
    return respond(200, { devices: paired ? [device] : [] });
  });

  await setupPage({ context, path: "/connectors?scope=remote-control" });
  await screen.findByText("No remote devices yet.");
  await waitFor(() => {
    expect(
      context.mocks.ably.hasSubscription("computerUseHostsChanged"),
    ).toBeTruthy();
  });
  paired = true;
  context.mocks.ably.trigger("computerUseHostsChanged");
  await findFastControl("link", "Studio Mac");
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
    name: "Allow access to Build Mac?",
  });
  expect(
    within(dialog).getByText(
      "Access covers all channels on this device across your chats.",
    ),
  ).toBeInTheDocument();
  click(await findFastControl("button", "Cancel", dialog));
  expect(dialog).not.toBeInTheDocument();
  expect(window.location.search).toBe("");
});

test("the chat device panel counts effective grants, filters devices and restores focus on return", async () => {
  enableRemoteDevices();
  let devices = Array.from({ length: 24 }, (_, index) => {
    return {
      id: "b0000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"),
      displayName:
        index === 23 ? "Find this test machine" : `Build Mac ${index + 1}`,
      accessAllowed: index < 3,
      accessExpiresAt:
        index === 1
          ? new Date(now() - 60_000).toISOString()
          : index === 2
            ? new Date(now() + 3_600_000).toISOString()
            : null,
      channels: [],
    };
  });
  context.mocks.api(remoteDevicesContract.list, ({ respond }) => {
    return respond(200, { devices });
  });
  const saveStarted = context.mocks.deferred<void>();
  const finishSave = context.mocks.deferred<void>();
  context.mocks.api(
    remoteDevicesContract.setAccess,
    async ({ params, body, respond }) => {
      const device = devices.find(({ id }) => {
        return id === params.deviceId;
      });
      if (!device) {
        throw new Error("Unexpected device");
      }
      expect(body).toStrictEqual({ mode: "always" });
      saveStarted.resolve();
      await finishSave.promise;
      const updated = { ...device, accessAllowed: true, accessExpiresAt: null };
      devices = devices.map((value) => {
        return value.id === updated.id ? updated : value;
      });
      return respond(200, updated);
    },
  );
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [],
  });
  await setupPage({ context, path: `/chats/${context.resourceId}` });
  click(await findFastControl("button", "Connectors"));
  const entry = await findFastControl("button", /Remote devices.*2 authorized/);
  expect(screen.queryByText("Build Mac 1")).toBeNull();
  click(entry);
  const back = await findFastControl("button", "Back");
  expect(back).toHaveFocus();
  const search = screen.getByRole("searchbox", { name: "Search devices" });
  await fill(search, "test machine");
  expect(screen.queryByText("Build Mac 1")).toBeNull();
  const manage = await findFastControl("link", "Manage devices");
  expect(manage).toHaveAttribute("href", "/connectors?scope=remote-control");
  await fill(search, "missing");
  expect(screen.getByText("No matching devices")).toBeInTheDocument();
  await fill(search, "test machine");
  const row = screen.getByText("Find this test machine").closest("li");
  if (!row) {
    throw new Error("Device row was not rendered");
  }
  click(await findFastControl("button", "Deny", row));
  click(within(await screen.findByRole("menu")).getByText("Allow always"));
  await saveStarted.promise;
  await fill(search, "missing");
  await fill(search, "test machine");
  const pending = await findFastControl(
    "button",
    /Find this test machine access, Deny/,
  );
  expect(pending).toHaveAttribute("aria-busy", "true");
  finishSave.resolve();
  await findFastControl("button", /Find this test machine access, Allow/);
  click(back);
  await expect(
    findFastControl("button", /Remote devices.*3 authorized/),
  ).resolves.toHaveFocus();
});

test("a temporary grant expires while the chat device panel is open", async () => {
  enableRemoteDevices();
  const start = Date.parse("2026-11-27T02:00:00Z");
  const expiresAt = start + 100;
  mockNow(start, context.signal);
  context.mocks.api(remoteDevicesContract.list, ({ respond }) => {
    return respond(200, {
      devices: [
        {
          id: deviceId,
          displayName: "Build Mac",
          accessAllowed: true,
          accessExpiresAt: new Date(expiresAt).toISOString(),
          channels: [],
        },
      ],
    });
  });
  installMessageExperienceChat({
    threadId: context.resourceId,
    chatEvents: [],
  });
  await setupPage({ context, path: `/chats/${context.resourceId}` });
  click(await findFastControl("button", "Connectors"));
  click(await findFastControl("button", /Remote devices.*1 authorized/));
  await findFastControl("button", /Build Mac access, Allow/);

  mockNow(expiresAt, context.signal);

  await expect(
    findFastControl("button", /Build Mac access, Deny/),
  ).resolves.toBeVisible();
  click(await findFastControl("button", "Back"));
  await expect(
    findFastControl("button", /Remote devices.*0 authorized/),
  ).resolves.toBeVisible();
});
