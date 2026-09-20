import { Plus, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useGet, useLoadable, useSet } from "ccstate-react";
import {
  vncAgentAccessRows$,
  openVncAccessManagement$,
} from "../../../../signals/vnc-access.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  ConnectorAgentAccessButton,
  connectorAgentAccessStatus,
} from "./connector-agent-access-button.tsx";
import { ROUTES } from "../../../../signals/route-paths.ts";
import { Link } from "../../../router/link.tsx";
import {
  ConnectorEntryCard,
  ConnectorEntryStatus,
} from "./connector-entry-card.tsx";

export function VncConnectorCard({
  configuredCount,
}: {
  readonly configuredCount: number;
}) {
  const { t } = useTranslation();
  const rows = useLoadable(vncAgentAccessRows$);
  const open = useSet(openVncAccessManagement$);
  const signal = useGet(pageSignal$);
  return (
    <ConnectorEntryCard
      icon={<Monitor size={20} aria-hidden="true" />}
      label={t(($) => {
        return $.vnc.label;
      })}
      description={t(($) => {
        return $.vnc.description;
      })}
      showDescription={configuredCount === 0}
      interactive
      action={
        <Link
          pathname={ROUTES.connectorVnc}
          options={
            configuredCount === 0
              ? { searchParams: new URLSearchParams({ add: "1" }) }
              : undefined
          }
          aria-label={t(($) => {
            return $.vnc.manage;
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
      status={
        <ConnectorEntryStatus
          tone={configuredCount > 0 ? "success" : "neutral"}
          className="min-w-0 flex-1 text-xs text-muted-foreground"
          label={t(
            ($) => {
              return $.vnc.summary;
            },
            { count: configuredCount },
          )}
        />
      }
      trailingAction={
        configuredCount > 0 ? (
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
                return $.vnc.label;
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
