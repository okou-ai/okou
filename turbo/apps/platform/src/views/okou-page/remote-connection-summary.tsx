import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Terminal, Monitor } from "lucide-react";

export function RemoteConnectionSummary({
  connection,
  protocol,
  route,
  account,
}: {
  readonly connection: {
    readonly displayName: string;
    readonly host: string;
    readonly port: number;
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
      </dl>
    </div>
  );
}
