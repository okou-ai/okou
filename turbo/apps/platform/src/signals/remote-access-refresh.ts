import { command, computed, state } from "ccstate";

const hostDefaultsReload$ = state(0);
const threadAccessReload$ = state(0);

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
