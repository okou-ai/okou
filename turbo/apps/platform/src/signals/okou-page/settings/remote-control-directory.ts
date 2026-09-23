import { command, computed, state } from "ccstate";

export type RemoteControlType = "all" | "ssh" | "vnc";
export type RemoteControlView = "connections" | "credentials";

const type$ = state<RemoteControlType>("all");
const view$ = state<RemoteControlView>("connections");

export const remoteControlType$ = computed((get) => {
  return get(type$);
});

export const remoteControlView$ = computed((get) => {
  return get(view$);
});

export const setRemoteControlType$ = command(
  ({ set }, value: RemoteControlType) => {
    set(type$, value);
  },
);

export const setRemoteControlView$ = command(
  ({ set }, value: RemoteControlView) => {
    set(view$, value);
  },
);
