import { command, computed, state } from "ccstate";

const reload$ = state(0);

export const remoteAccessReload$ = computed((get) => {
  return get(reload$);
});

export const invalidateRemoteAccess$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});
