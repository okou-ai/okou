import { useGet, useLastResolved, useSet } from "ccstate-react";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { remoteSetup$ } from "../../signals/remote-control-setup.ts";
import {
  mountRemoteDeviceDirectory$,
  remoteDevicesEnabled$,
} from "../../signals/remote-devices.ts";
import { RemoteDeviceDirectory } from "./remote-device-directory.tsx";
import {
  GuidedRemoteControlPanel,
  GuidedPrivateNetworkPanel,
} from "./remote-guided-directory.tsx";

export function RemoteControlPanel() {
  const enabled = useLastResolved(remoteDevicesEnabled$);
  const setup = useGet(remoteSetup$);
  const session = useGet(authenticatedSessionKey$);
  const mount = useSet(mountRemoteDeviceDirectory$);
  if (enabled && !setup) {
    return (
      <div key={session} ref={mount}>
        <RemoteDeviceDirectory />
      </div>
    );
  }
  return <GuidedRemoteControlPanel />;
}

export function PrivateNetworkPanel() {
  return <GuidedPrivateNetworkPanel />;
}
