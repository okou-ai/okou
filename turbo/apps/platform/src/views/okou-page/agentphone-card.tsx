import { WorksChannelCardContent } from "./components/works-channel-card-content.tsx";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { EllipsisVertical } from "lucide-react";
import { surfaceVariants, Button } from "@okouai/ui";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui/components/ui/tooltip";
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
import { AgentPhoneConnectDialog } from "./agentphone-connect-dialog.tsx";

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
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  data-testid="agentphone-connected-indicator"
                  className="min-w-0 flex-1 text-xs text-muted-foreground"
                >
                  <span className="min-w-0 break-all">
                    {connectedPhone ??
                      t(($) => {
                        return $.connectors.providerSettings.works.connected;
                      })}
                  </span>
                </span>
              }
            />
            <TooltipContent>
              {t(($) => {
                return $.connectors.providerSettings.agentphone
                  .authorizedSender;
              })}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : null}
      {status !== null && !isConnected && canConnect ? (
        <Button
          type="button"
          variant="quiet"
          size="xs"
          className="shrink-0 gap-1.5 px-2 text-xs"
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
        className={surfaceVariants({ className: "flex min-w-0 flex-col" })}
      >
        <WorksChannelCardContent
          actionsPlacement={status?.linked ? "footer" : "header"}
          icon={<img src={imessageIconImg} alt="" className="size-5" />}
          title={t(($) => {
            return $.connectors.providerSettings.agentphone.phoneLabel;
          })}
          description={t(($) => {
            return $.connectors.providerSettings.agentphone.description;
          })}
          actions={
            <>
              <AgentPhoneCardActions
                canConnect={agentPhoneNumber !== null}
                onConnect={() => {
                  requestConnectionCode();
                  setConnectOpen(true);
                }}
              />
            </>
          }
        />
      </div>
      <AgentPhoneConnectDialog
        phoneNumber={agentPhoneNumber}
        connectionCode={connectionCode}
        connectionCodeFailed={connectionCodeLoadable.state === "hasError"}
      />
    </>
  );
}
