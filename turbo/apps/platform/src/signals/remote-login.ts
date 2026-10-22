import { command, computed, state } from "ccstate";
import { authenticatedSessionKey$ } from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
export type RemoteLoginProtocol = "ssh" | "vnc";
interface LoginImpact {
  readonly sessionKey: string | null;
  readonly protocol: RemoteLoginProtocol;
  readonly hosts: readonly {
    readonly id: string;
    readonly displayName: string;
  }[];
}
const picker$ = state<{
  readonly sessionKey: string | null;
  readonly protocol: RemoteLoginProtocol;
} | null>(null);
const impact$ = state<LoginImpact | null>(null);
const confirmed$ = state<RemoteLoginProtocol | null>(null);
export const remoteLoginPicker$ = computed((get) => {
  const current = get(picker$);
  return get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup] &&
    current?.sessionKey === get(authenticatedSessionKey$)
    ? current.protocol
    : null;
});
export const setRemoteLoginPicker$ = command(
  ({ get, set }, protocol: RemoteLoginProtocol | null) => {
    set(
      picker$,
      protocol ? { sessionKey: get(authenticatedSessionKey$), protocol } : null,
    );
  },
);
export const remoteLoginImpact$ = computed((get) => {
  const current = get(impact$);
  return get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup] &&
    current?.sessionKey === get(authenticatedSessionKey$)
    ? current
    : null;
});
export const requestRemoteLoginSave$ = command(
  (
    { get, set },
    protocol: RemoteLoginProtocol,
    hosts: LoginImpact["hosts"],
    changed: boolean,
  ) => {
    if (get(confirmed$) === protocol) {
      set(confirmed$, null);
      return true;
    }
    if (changed && hosts.length > 1) {
      set(impact$, {
        sessionKey: get(authenticatedSessionKey$),
        protocol,
        hosts,
      });
      return false;
    }
    return true;
  },
);
export const confirmRemoteLoginSave$ = command(
  ({ get, set }, protocol: RemoteLoginProtocol) => {
    if (get(remoteLoginImpact$)?.protocol === protocol) {
      set(confirmed$, protocol);
      set(impact$, null);
    }
  },
);
export const cancelRemoteLoginSave$ = command(({ set }) => {
  set(impact$, null);
  set(confirmed$, null);
});
export const resetRemoteLogin$ = command(({ set }) => {
  set(picker$, null);
  set(impact$, null);
  set(confirmed$, null);
});
