import { command, computed, state } from "ccstate";

const hostDefaultsReload$ = state(0);
const threadAccessReload$ = state(0);
// SSH carrier rotations do not change the VNC generation. Fence retained
// diagnostics whenever either protocol's configuration is refreshed.
const vncObservationConfigurationRevisionState$ = state(0);

export const vncObservationConfigurationRevision$ = computed((get) => {
  return get(vncObservationConfigurationRevisionState$);
});

export const invalidateVncObservationConfiguration$ = command(({ set }) => {
  set(vncObservationConfigurationRevisionState$, (value) => {
    return value + 1;
  });
  return false;
});

export const remoteHostDefaultsReload$ = computed((get) => {
  return get(hostDefaultsReload$);
});

export const threadRemoteAccessReload$ = computed((get) => {
  return get(threadAccessReload$);
});

export const invalidateThreadRemoteAccess$ = command(({ set }) => {
  set(threadAccessReload$, (value) => {
    return value + 1;
  });
});

export const invalidateRemoteAccess$ = command(({ set }) => {
  set(hostDefaultsReload$, (value) => {
    return value + 1;
  });
  set(invalidateThreadRemoteAccess$);
});
