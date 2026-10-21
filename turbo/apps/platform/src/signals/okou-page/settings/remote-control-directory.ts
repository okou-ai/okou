import { command, computed, state } from "ccstate";
import { searchParams$, updateSearchParams$ } from "../../route.ts";
import {
  remoteControlGuidedEnabled$,
  remoteSetup$,
} from "../../remote-control-setup.ts";
import { closeSshDialog$ } from "../../ssh.ts";
import { closeVncDialog$ } from "../../vnc.ts";

export type RemoteControlType = "all" | "ssh" | "vnc";
export type RemoteControlView = "connections" | "credentials";

const view$ = state<RemoteControlView>("connections");

export const remoteCredentialsPage$ = computed((get) => {
  const params = get(searchParams$);
  return (
    get(remoteControlGuidedEnabled$) &&
    get(remoteSetup$) === null &&
    params.get("scope") === "remote-control" &&
    params.get("remoteView") === "credentials"
  );
});

export const closeRemoteCredentialsPage$ = command(({ get, set }) => {
  set(closeSshDialog$);
  set(closeVncDialog$);
  const params = new URLSearchParams(get(searchParams$));
  params.delete("remoteView");
  params.delete("type");
  set(updateSearchParams$, params);
});

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
