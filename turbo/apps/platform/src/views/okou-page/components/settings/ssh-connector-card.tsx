import { Plus, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGet, useLoadable, useSet } from "ccstate-react";
import {
  sshAgentAccessRows$,
  openSshAccessManagement$,
} from "../../../../signals/ssh.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  ConnectorAgentAccessButton,
  connectorAgentAccessStatus,
} from "./connector-agent-access-button.tsx";
import { ROUTES } from "../../../../signals/route-paths.ts";
import { Link } from "../../../router/link.tsx";
import { ConnectorEntryCard } from "./connector-entry-card.tsx";
import { SshConnectionSummary } from "../../ssh-connection-status.tsx";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../../../signals/external/feature-switch.ts";

export function SshConnectorCard({
  configuredCount,
}: {
  readonly configuredCount: number;
}) {
  const { t } = useTranslation();
  const threadRemoteAccess =
    useGet(featureSwitch$)[FeatureSwitchKey.ThreadRemoteAccess] === true;
  const rows = useLoadable(sshAgentAccessRows$);
  const open = useSet(openSshAccessManagement$);
  const signal = useGet(pageSignal$);
  return (
    <ConnectorEntryCard
      icon={<Terminal size={20} aria-hidden="true" />}
      label={t(($) => {
        return $.ssh.label;
      })}
      description={t(($) => {
        return $.ssh.description;
      })}
      showDescription={configuredCount === 0}
      interactive
      action={
        <Link
          pathname={ROUTES.connectors}
          options={{
            searchParams: new URLSearchParams({
              scope: "remote-control",
              type: "ssh",
            }),
          }}
          aria-label={t(($) => {
            return $.ssh.manage;
          })}
          className="absolute inset-0 z-10 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      }
      indicator={
        configuredCount === 0 ? (
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground"
            aria-hidden="true"
          >
            <Plus size={14} />
          </span>
        ) : null
      }
      status={<SshConnectionSummary configuredCount={configuredCount} />}
      trailingAction={
        configuredCount > 0 && !threadRemoteAccess ? (
          <div className="relative z-20 min-w-0 max-w-full">
            <ConnectorAgentAccessButton
              agents={
                rows.state === "hasData"
                  ? (rows.data ?? [])
                      .filter((row) => {
                        return row.enabled;
                      })
                      .map((row) => {
                        return row.agent;
                      })
                  : []
              }
              status={connectorAgentAccessStatus(rows.state)}
              allowAccessIncrease
              connectorLabel={t(($) => {
                return $.ssh.label;
              })}
              onClick={() => {
                return detach(open(signal), Reason.DomCallback);
              }}
            />
          </div>
        ) : null
      }
    />
  );
}
