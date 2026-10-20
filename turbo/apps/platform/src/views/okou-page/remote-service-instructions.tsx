import { useTranslation } from "react-i18next";
import type { RemoteSetupOs } from "../../signals/remote-control-setup.ts";

export function RemoteServiceInstructions({
  os,
  vnc,
}: {
  readonly os: RemoteSetupOs;
  readonly vnc: boolean;
}) {
  const { t } = useTranslation();
  const steps = vnc
    ? os === "mac"
      ? [
          t(($) => {
            return $.remoteServiceGuide.macSharing;
          }),
          t(($) => {
            return $.remoteServiceGuide.macScreenSharing;
          }),
          t(($) => {
            return $.remoteServiceGuide.macAllowedUsers;
          }),
        ]
      : [
          t(($) => {
            return os === "windows"
              ? $.remoteServiceGuide.windowsVnc
              : $.remoteServiceGuide.linuxVnc;
          }),
          t(($) => {
            return $.remoteServiceGuide.startVnc;
          }),
          t(($) => {
            return $.remoteServiceGuide.recordVncSettings;
          }),
        ]
    : os === "mac"
      ? [
          t(($) => {
            return $.remoteServiceGuide.macSharing;
          }),
          t(($) => {
            return $.remoteServiceGuide.macRemoteLogin;
          }),
          t(($) => {
            return $.remoteServiceGuide.macAllowedUsers;
          }),
        ]
      : os === "windows"
        ? [
            t(($) => {
              return $.remoteServiceGuide.windowsOpenSsh;
            }),
            t(($) => {
              return $.remoteServiceGuide.windowsStartSsh;
            }),
            t(($) => {
              return $.remoteServiceGuide.allowSshPort;
            }),
          ]
        : [
            t(($) => {
              return $.remoteServiceGuide.linuxOpenSsh;
            }),
            t(($) => {
              return $.remoteServiceGuide.linuxStartSsh;
            }),
            t(($) => {
              return $.remoteServiceGuide.allowSshPort;
            }),
          ];
  return (
    <ol className="grid gap-4 text-sm leading-6">
      {steps.map((step, index) => {
        return (
          <li key={step} className="flex items-start gap-3">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-gray-50 text-xs text-muted-foreground">
              {index + 1}
            </span>
            <span>{step}</span>
          </li>
        );
      })}
    </ol>
  );
}
