import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, Monitor, Unplug } from "lucide-react";
import { Button } from "@okouai/ui";
import { REMOTE_PAGE_ACTION } from "./remote-editor-frame.tsx";
import { SshLastCheck } from "./ssh-connection-status.tsx";
import { VncLastCheck } from "./vnc-connection-status.tsx";

export function RemoteConnectionSummary({
  connection,
  protocol,
  route,
  account,
}: {
  readonly connection: {
    readonly id: string;
    readonly displayName: string;
    readonly host: string;
    readonly port: number;
    readonly generation: number;
    readonly createdAt: string;
  };
  readonly protocol: "ssh" | "vnc";
  readonly route: ReactNode;
  readonly account?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-6">
      <header className="flex items-center justify-between gap-4">
        <div className="grid gap-2">
          <h2 className="text-lg font-semibold">{connection.displayName}</h2>
          <p className="text-sm text-muted-foreground">
            {protocol.toUpperCase()} ·{" "}
            {t(($) => {
              return protocol === "ssh"
                ? $.remoteControlSetup.sshDescription
                : $.remoteControlSetup.vncDescription;
            })}
          </p>
        </div>
        <span className="rounded-xl bg-gray-50 p-3">
          {protocol === "ssh" ? (
            <Terminal size={20} aria-hidden />
          ) : (
            <Monitor size={20} aria-hidden />
          )}
        </span>
      </header>
      <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-4 text-sm sm:grid-cols-[7.25rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.address;
          })}
        </dt>
        <dd className="break-all">
          {connection.host}:{connection.port}
        </dd>
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.connectionSettings;
          })}
        </dt>
        <dd>{route}</dd>
        {account && (
          <>
            <dt className="text-muted-foreground">
              {t(($) => {
                return $.remoteControlSetup.loginHeading;
              })}
            </dt>
            <dd className="break-all">{account}</dd>
          </>
        )}
        <dt className="text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.checkStatus;
          })}
        </dt>
        <dd>
          {protocol === "ssh" ? (
            <SshLastCheck
              connectionId={connection.id}
              generation={connection.generation}
              createdAt={connection.createdAt}
            />
          ) : (
            <VncLastCheck
              connectionId={connection.id}
              generation={connection.generation}
              createdAt={connection.createdAt}
            />
          )}
        </dd>
      </dl>
    </div>
  );
}
export function RemoteConnectionCheckUnavailable() {
  const { t } = useTranslation();
  return (
    <footer className="grid gap-5 border-t border-divider pt-5">
      <div className="flex gap-3" role="status">
        <Unplug
          size={18}
          className="mt-0.5 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">
            {t(($) => {
              return $.remoteControlSetup.checkUnavailable;
            })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.checkUnavailableHelp;
            })}
          </p>
        </div>
      </div>
      <Button disabled className={`${REMOTE_PAGE_ACTION} justify-self-end`}>
        {t(($) => {
          return $.remoteControlSetup.checkConnection;
        })}
      </Button>
    </footer>
  );
}
