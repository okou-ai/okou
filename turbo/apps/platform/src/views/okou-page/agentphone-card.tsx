import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { CircleCheck, EllipsisVertical } from "lucide-react";
import { surfaceVariants, Button } from "@okouai/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  agentPhoneLinkStatus$,
  createAgentPhoneLinkCode$,
  disconnectAgentPhone$,
  setAgentPhoneConnectDialogOpen$,
} from "../../signals/okou-page/agentphone.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  AgentPhoneConnectDialog,
  PhoneNumberCopyButton,
} from "./agentphone-connect-dialog.tsx";

const imessageIconImg = settingsIconAssetUrl("imessage");

function AgentPhoneCardActions({
  canConnect,
  onConnect,
}: {
  readonly canConnect: boolean;
  readonly onConnect: () => void;
}) {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(agentPhoneLinkStatus$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const [disconnectLoadable, disconnect] = useLoadableSet(
    disconnectAgentPhone$,
  );
  const pageSignal = useGet(pageSignal$);
  const disconnecting = disconnectLoadable.state === "loading";
  const isConnected = status?.linked ?? false;
  const connectedPhone = status?.linked ? status.phoneHandle : null;

  return (
    <>
      {isConnected ? (
        <span
          data-testid="agentphone-connected-indicator"
          className="inline-flex min-w-0 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-background px-1.5 py-1 text-xs font-medium text-secondary-foreground"
        >
          <CircleCheck
            className="h-3 w-3 shrink-0 text-green-600"
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block text-muted-foreground">
              {t(($) => {
                return $.connectors.providerSettings.agentphone
                  .authorizedSender;
              })}
            </span>
            <span className="block truncate">
              {connectedPhone ??
                t(($) => {
                  return $.connectors.providerSettings.works.connected;
                })}
            </span>
          </span>
        </span>
      ) : null}
      {status !== null && !isConnected && canConnect ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 rounded-lg"
          aria-label={t(($) => {
            return $.connectors.providerSettings.agentphone.connectAria;
          })}
          onClick={onConnect}
        >
          {t(($) => {
            return $.connectors.actions.connect;
          })}
        </Button>
      ) : null}
      {isConnected ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                showTooltip
                type="button"
                variant="quiet"
                size="icon-xs"
                className="shrink-0"
                aria-label={t(($) => {
                  return $.connectors.providerSettings.agentphone.options;
                })}
              >
                <EllipsisVertical size={16} />
              </Button>
            }
          />
          <PopoverContent
            align="end"
            className="flex flex-col gap-0.5 w-40 p-2"
          >
            <button
              type="button"
              aria-label={t(($) => {
                return $.connectors.actions.disconnect;
              })}
              disabled={disconnecting}
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-left hover:bg-state-hover hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:pointer-events-none"
              onClick={() => {
                return detach(disconnect(pageSignal), Reason.DomCallback);
              }}
            >
              {disconnecting
                ? t(($) => {
                    return $.connectors.actions.disconnecting;
                  })
                : t(($) => {
                    return $.connectors.actions.disconnect;
                  })}
            </button>
          </PopoverContent>
        </Popover>
      ) : null}
    </>
  );
}

export function AgentPhoneCard() {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(agentPhoneLinkStatus$);
  const [connectionCodeLoadable, createConnectionCode] = useLoadableSet(
    createAgentPhoneLinkCode$,
  );
  const pageSignal = useGet(pageSignal$);
  const setConnectOpen = useSet(setAgentPhoneConnectDialogOpen$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const agentPhoneNumber = status?.agentPhoneNumber ?? null;
  const connectionCode =
    connectionCodeLoadable.state === "hasData"
      ? connectionCodeLoadable.data
      : null;
  const requestConnectionCode = () => {
    detach(createConnectionCode(pageSignal), Reason.DomCallback);
  };

  return (
    <>
      <div
        data-slot="integration-card"
        className={surfaceVariants({ className: "flex flex-col" })}
      >
        <div className="flex items-center gap-4 p-4">
          <div className="shrink-0 inline-flex h-7 w-7 items-center justify-center overflow-hidden">
            <img src={imessageIconImg} alt="" className="h-7 w-7" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-medium text-foreground">
                {t(($) => {
                  return $.connectors.providerSettings.agentphone.phoneLabel;
                })}
              </div>
            </div>
            <div className="truncate text-sm text-muted-foreground">
              {agentPhoneNumber ? (
                <span className="inline-flex max-w-full items-center gap-1">
                  <span className="shrink-0">
                    {t(($) => {
                      return $.connectors.providerSettings.agentphone
                        .destination;
                    })}
                  </span>
                  <PhoneNumberCopyButton phoneNumber={agentPhoneNumber} />
                </span>
              ) : (
                t(($) => {
                  return $.connectors.providerSettings.agentphone.description;
                })
              )}
            </div>
          </div>
          <AgentPhoneCardActions
            canConnect={agentPhoneNumber !== null}
            onConnect={() => {
              requestConnectionCode();
              setConnectOpen(true);
            }}
          />
        </div>
      </div>
      <AgentPhoneConnectDialog
        phoneNumber={agentPhoneNumber}
        connectionCode={connectionCode}
        connectionCodeFailed={connectionCodeLoadable.state === "hasError"}
        onRetry={requestConnectionCode}
      />
    </>
  );
}
