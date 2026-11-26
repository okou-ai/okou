import { remoteDevicesContract } from "@okouai/api-contracts/client/remote-devices";
import type {
  RemoteDeviceAccess,
  RemoteDeviceChannel,
} from "@okouai/api-contracts/contracts/remote-devices";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";
import { uuid } from "zod";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitches$ } from "./external/feature-switch.ts";
import { setAblyInvalidationLoop$ } from "./realtime.ts";
import { searchParams$ } from "./route.ts";
import { onRef } from "./utils.ts";

const revision$ = state(0);

export const remoteDevicesEnabled$ = computed(async (get) => {
  return (await get(featureSwitches$))[FeatureSwitchKey.RemoteDevices];
});

export const selectedRemoteDeviceId$ = computed((get) => {
  const selected = uuid().safeParse(get(searchParams$).get("remoteDevice"));
  return selected.success ? selected.data : undefined;
});

export const invalidateRemoteDeviceDirectory$ = command(({ set }) => {
  set(revision$, (current) => {
    return current + 1;
  });
});

export const mountRemoteDeviceDirectory$ = onRef(
  command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
    set(
      setAblyInvalidationLoop$,
      {
        scope: "credential",
        topic: "remoteDevicesChanged",
        invalidations: [invalidateRemoteDeviceDirectory$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
  }),
);

export const remoteDeviceDirectory$ = computed(async (get) => {
  const session = get(authenticatedSessionKey$);
  get(revision$);
  if (!session || !(await get(remoteDevicesEnabled$))) {
    return [];
  }
  const { body } = await accept(
    get(apiClient$)(remoteDevicesContract).list(),
    [200],
  );
  return body.devices;
});

export const createRemoteDevice$ = command(
  async (
    { get, set },
    id: string,
    displayName: string,
    signal: AbortSignal,
  ) => {
    const result = await accept(
      get(apiClient$)(remoteDevicesContract).create({
        body: { id, displayName },
        fetchOptions: { signal },
      }),
      [200, 201],
      signal,
    );
    set(invalidateRemoteDeviceDirectory$);
    return result.body;
  },
);

export const updateRemoteDeviceAccess$ = command(
  async (
    { get, set },
    deviceId: string,
    body: RemoteDeviceAccess,
    signal: AbortSignal,
  ) => {
    await accept(
      get(apiClient$)(remoteDevicesContract).setAccess({
        params: { deviceId },
        body,
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    set(invalidateRemoteDeviceDirectory$);
  },
);

export const moveRemoteDeviceChannel$ = command(
  async (
    { get, set },
    channel: Pick<RemoteDeviceChannel, "id" | "kind">,
    deviceId: string,
    signal: AbortSignal,
  ) => {
    await accept(
      get(apiClient$)(remoteDevicesContract).moveChannel({
        params: { deviceId, channelId: channel.id, kind: channel.kind },
        body: undefined,
        fetchOptions: { signal },
      }),
      [204],
      signal,
    );
    set(invalidateRemoteDeviceDirectory$);
  },
);
