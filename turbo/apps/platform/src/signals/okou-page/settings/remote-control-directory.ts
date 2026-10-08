import { command, computed, state } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../../route.ts";

export type RemoteControlType = "all" | "ssh" | "vnc";
export type RemoteControlView = "connections" | "credentials";

const view$ = state<RemoteControlView>("connections");

export const remoteControlType$ = computed((get) => {
  const type = get(searchParams$).get("type");
  return type === "ssh" || type === "vnc" ? type : "all";
});

export const remoteControlView$ = computed((get) => {
  return get(view$);
});

export const setRemoteControlType$ = command(
  ({ get, set }, value: RemoteControlType) => {
    const params = new URLSearchParams(get(searchParams$));
    if (value === "all") {
      params.delete("type");
    } else {
      params.set("type", value);
    }
    set(updateSearchParams$, params);
  },
);

export const setRemoteControlView$ = command(
  ({ set }, value: RemoteControlView) => {
    set(view$, value);
  },
);
