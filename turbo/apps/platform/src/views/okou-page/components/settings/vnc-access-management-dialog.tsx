import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Monitor } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
} from "@okouai/ui";
import {
  closeVncAccessManagement$,
  vncAccessManagementOpen$,
  vncAgentAccessRows$,
  vncAccessSearch$,
  searchVncAccess$,
  updateAgentVncAccess$,
} from "../../../../signals/vnc-access.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { AvatarFromUrl } from "../../sidebar-shared.tsx";
import { LoadingSwitch } from "../../../components/loading-switch.tsx";
import { VncLoadError } from "../../vnc-load-error.tsx";

export function VncAccessManagementDialog() {
  const { t } = useTranslation();
  const open = useLoadable(vncAccessManagementOpen$);
  const close = useSet(closeVncAccessManagement$);
  const search = useGet(vncAccessSearch$);
  const setSearch = useSet(searchVncAccess$);
  if (open.state !== "hasData" || !open.data) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value) {
          close();
        }
      }}
    >
      <DialogContent
        maxWidth={720}
        height={720}
        contentClassName="flex flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0 gap-2">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Monitor size={20} />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base">
                {t(
                  ($) => {
                    return $.connectors.access.title;
                  },
                  { connector: "VNC" },
                )}
              </DialogTitle>
              <DialogDescription>
                {t(($) => {
                  return $.vnc.accessDescription;
                })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <Input
          value={search}
          onChange={(event) => {
            return setSearch(event.currentTarget.value);
          }}
          aria-label={t(($) => {
            return $.connectors.access.search;
          })}
          placeholder={t(($) => {
            return $.connectors.access.search;
          })}
        />
        <VncAccessManagementRows />
      </DialogContent>
    </Dialog>
  );
}

function VncAccessManagementRows() {
  const { t } = useTranslation();
  const rows = useLoadable(vncAgentAccessRows$);
  const search = useGet(vncAccessSearch$);
  const [saving, update] = useLoadableSet(updateAgentVncAccess$);
  const signal = useGet(pageSignal$);
  const filtered =
    rows.state === "hasData"
      ? rows.data?.filter((row) => {
          return (row.agent.displayName ?? "")
            .toLowerCase()
            .includes(search.trim().toLowerCase());
        })
      : undefined;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {rows.state === "hasError" ? (
        <VncLoadError />
      ) : rows.state === "loading" ? (
        <p
          role="status"
          className="py-8 text-center text-sm text-muted-foreground"
        >
          {t(($) => {
            return $.vnc.loadingAccess;
          })}
        </p>
      ) : rows.data === null ? (
        <p>
          {t(($) => {
            return $.vnc.unavailable;
          })}
        </p>
      ) : filtered?.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {search.trim()
            ? t(
                ($) => {
                  return $.connectors.access.noMatchingAgents;
                },
                {
                  search: search.trim(),
                },
              )
            : t(($) => {
                return $.connectors.access.noAgents;
              })}
        </p>
      ) : (
        filtered?.map((row) => {
          const name =
            row.agent.displayName ??
            t(($) => {
              return $.connectors.catalog.unnamedAgent;
            });
          return (
            <div
              key={row.agent.agentId}
              className="flex items-center gap-2 px-1 py-4"
            >
              <AvatarFromUrl
                avatarUrl={row.agent.avatarUrl}
                alt={name}
                className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
              />
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                {name}
              </p>
              <LoadingSwitch
                checked={row.enabled}
                loading={saving.state === "loading"}
                onCheckedChange={(enabled) => {
                  return detach(
                    update(row.agent.agentId, enabled, signal),
                    Reason.DomCallback,
                  );
                }}
                ariaLabel={t(
                  ($) => {
                    return $.connectors.access.accessFor;
                  },
                  {
                    action: row.enabled
                      ? t(($) => {
                          return $.connectors.actions.revoke;
                        })
                      : t(($) => {
                          return $.connectors.actions.authorize;
                        }),
                    connector: "VNC",
                    agent: name,
                  },
                )}
              />
            </div>
          );
        })
      )}
    </div>
  );
}
