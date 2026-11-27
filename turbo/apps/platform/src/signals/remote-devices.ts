import { delay } from "signal-timers";
import { now } from "../lib/time.ts";
import { remoteDevicesContract } from "@okouai/api-contracts/client/remote-devices";
import type {
  RemoteDeviceAccess,
  RemoteDeviceChannel,
} from "@okouai/api-contracts/contracts/remote-devices";
import { phoneUseDevicesChangedEvent } from "@okouai/api-contracts/validators/phone-use";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed, state } from "ccstate";
import { uuid } from "zod";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitches$ } from "./external/feature-switch.ts";
import { setAblyInvalidationLoop$ } from "./realtime.ts";
import { searchParams$, updateSearchParams$ } from "./route.ts";
import { onRef } from "./utils.ts";

const revision$ = state(0);
const creation$ = state<{ readonly id: string; readonly name: string } | null>(
  null,
);

// Browsers cannot schedule a single timeout beyond this delay. The open
// composer schedules the remaining time again if the grant is still active.
const MAX_TIMEOUT_MS = 2_147_483_647;
const remoteDeviceClock$ = state(0);
export const composerRemoteDeviceClock$ = computed((get) => {
  return get(remoteDeviceClock$);
});

export const mountComposerRemoteDeviceExpiry$ = onRef(
  command(async ({ set }, element: HTMLTimeElement, signal: AbortSignal) => {
    const remaining = Date.parse(element.dateTime) - now();
    await delay(Math.min(MAX_TIMEOUT_MS, Math.max(0, remaining)), { signal });
    signal.throwIfAborted();
    set(remoteDeviceClock$, (tick) => {
      return tick + 1;
    });
  }),
);

export const focusDeviceMenuControl$ = onRef(
  command((_context, element: HTMLElement, _signal: AbortSignal) => {
    element.focus({ preventScroll: true });
  }),
);

export const remoteDeviceCreation$ = computed((get) => {
  return get(creation$);
});

export const setRemoteDeviceCreationOpen$ = command(
  ({ set }, open: boolean) => {
    set(creation$, open ? { id: crypto.randomUUID(), name: "" } : null);
  },
);

export const updateRemoteDeviceName$ = command(({ get, set }, name: string) => {
  const draft = get(creation$);
  if (draft) {
    set(creation$, { ...draft, name });
  }
});

export const mountRemoteDeviceCreation$ = onRef(
  command(({ set }, _element: HTMLElement, signal: AbortSignal) => {
    signal.addEventListener(
      "abort",
      () => {
        set(creation$, null);
      },
      { once: true },
    );
  }),
);

const renameDraft$ = state<{
  readonly deviceId: string;
  readonly name: string | null;
  readonly open: boolean;
  readonly request: Promise<unknown> | null;
} | null>(null);

export const remoteDeviceRenameDraft$ = computed((get) => {
  return get(renameDraft$);
});

export const remoteDeviceRenameRequest$ = computed((get) => {
  return get(renameDraft$)?.request ?? null;
});

export const openRemoteDeviceRename$ = command(({ set }, deviceId: string) => {
  set(renameDraft$, { deviceId, name: null, open: true, request: null });
});

export const updateRemoteDeviceRename$ = command(
  ({ get, set }, name: string) => {
    const draft = get(renameDraft$);
    if (draft?.open) {
      set(renameDraft$, { ...draft, name });
    }
  },
);

export const closeRemoteDeviceRename$ = command(({ get, set }) => {
  const draft = get(renameDraft$);
  if (draft?.open) {
    set(renameDraft$, { ...draft, open: false });
  }
});

export const finishRemoteDeviceRenameClose$ = command(({ get, set }) => {
  if (!get(renameDraft$)?.open) {
    set(renameDraft$, null);
  }
});

export const mountRemoteDeviceRename$ = onRef(
  command(({ set }, _element: HTMLButtonElement, signal: AbortSignal) => {
    signal.addEventListener(
      "abort",
      () => {
        set(renameDraft$, null);
      },
      { once: true },
    );
  }),
);

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
    for (const [scope, topic] of [
      ["credential", "remoteDevicesChanged"],
      ["credential", phoneUseDevicesChangedEvent],
      ["user", "computerUseHostsChanged"],
    ] as const) {
      set(
        setAblyInvalidationLoop$,
        {
          scope,
          topic,
          invalidations: [invalidateRemoteDeviceDirectory$],
          options: { runOnSubscribe: topic === "remoteDevicesChanged" },
        },
        signal,
      );
    }
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
  async ({ get, set }, signal: AbortSignal) => {
    const draft = get(creation$);
    if (!draft?.name.trim()) {
      return;
    }
    await accept(
      get(apiClient$)(remoteDevicesContract).create({
        body: { id: draft.id, displayName: draft.name },
        fetchOptions: { signal },
      }),
      [200, 201],
      signal,
    );
    set(invalidateRemoteDeviceDirectory$);
    if (get(creation$)?.id === draft.id) {
      set(creation$, null);
      const params = new URLSearchParams(get(searchParams$));
      params.delete("setup");
      params.set("remoteDevice", draft.id);
      set(updateSearchParams$, params);
    }
  },
);

export const renameRemoteDevice$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const draft = get(renameDraft$);
    if (!draft?.open || draft.name === null) {
      return;
    }
    const request = accept(
      get(apiClient$)(remoteDevicesContract).rename({
        params: { deviceId: draft.deviceId },
        body: { displayName: draft.name.trim() },
        fetchOptions: { signal },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    const submittedDraft = { ...draft, request };
    set(renameDraft$, submittedDraft);
    await request;
    signal.throwIfAborted();
    set(invalidateRemoteDeviceDirectory$);
    if (get(renameDraft$) === submittedDraft) {
      set(closeRemoteDeviceRename$);
    }
  },
);

const pendingDeviceAccess$ = state<ReadonlySet<string>>(new Set());

export const deleteRemoteDevice$ = command(
  async ({ get, set }, deviceId: string, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(remoteDevicesContract).delete({
        params: { deviceId },
        body: undefined,
        fetchOptions: { signal },
      }),
      [204],
      signal,
    );
    signal.throwIfAborted();
    set(invalidateRemoteDeviceDirectory$);
    if (get(selectedRemoteDeviceId$) === deviceId) {
      const params = new URLSearchParams(get(searchParams$));
      params.delete("remoteDevice");
      set(updateSearchParams$, params);
    }
  },
);

export const remoteDeviceAccessPending$ = computed((get) => {
  return get(pendingDeviceAccess$);
});

export const updateRemoteDeviceAccess$ = command(
  async (
    { get, set },
    deviceId: string,
    body: RemoteDeviceAccess,
    signal: AbortSignal,
  ) => {
    const pending = get(pendingDeviceAccess$);
    if (pending.has(deviceId)) {
      return;
    }
    set(pendingDeviceAccess$, new Set([...pending, deviceId]));
    const saving = accept(
      get(apiClient$)(remoteDevicesContract).setAccess({
        params: { deviceId },
        body,
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    await saving.finally(() => {
      set(pendingDeviceAccess$, (current) => {
        const remaining = new Set(current);
        remaining.delete(deviceId);
        return remaining;
      });
    });
    signal.throwIfAborted();
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
