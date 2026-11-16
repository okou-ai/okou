import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Plug, RefreshCw, Smartphone } from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  PopoverClose,
} from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { PhoneDevice } from "@okouai/api-contracts/contracts/phone-use";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import type { ComposerConnectorSignals } from "../../signals/okou-page/connectors.ts";

function PhoneRow({ device }: { readonly device: PhoneDevice }) {
  const { t } = useTranslation();
  return (
    <li className="flex items-center gap-2 px-2 py-1.5 text-sm">
      <Smartphone size={16} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={device.displayName}>
        {device.displayName}
      </span>
      <Badge className="shrink-0 text-xs text-muted-foreground">
        {device.ready
          ? t(($) => {
              return $.chat.phoneUse.ready;
            })
          : t(($) => {
              return $.chat.phoneUse.notReady;
            })}
      </Badge>
    </li>
  );
}

function PhoneUseDevices({ signals }: { signals: ComposerConnectorSignals }) {
  const { t } = useTranslation();
  const devices = useLoadable(signals.resources.phoneUseDevices$);
  const reload = useSet(signals.resources.reloadPhoneUseDevices$);
  const updateUi = useSet(signals.updateConnectorUiState$);
  return (
    <div className="shrink-0 border-t border-border/50 bg-gray-50 p-1 dark:bg-gray-100">
      <div className="flex items-center justify-between px-2 pt-1 text-xs font-medium text-muted-foreground">
        <span>
          {t(($) => {
            return $.chat.phoneUse.yourPhone;
          })}
        </span>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={t(($) => {
            return $.chat.phoneUse.refresh;
          })}
          onClick={() => {
            reload();
          }}
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      {devices.state === "hasData" && devices.data.length > 0 ? (
        <ul
          className="flex max-h-[96px] flex-col overflow-y-auto"
          aria-label={t(($) => {
            return $.chat.phoneUse.yourPhone;
          })}
        >
          {devices.data.map((device) => {
            return <PhoneRow key={device.id} device={device} />;
          })}
        </ul>
      ) : (
        <p className="px-2 py-1.5 text-xs text-muted-foreground" role="status">
          {devices.state === "hasError"
            ? t(($) => {
                return $.chat.phoneUse.loadError;
              })
            : devices.state === "hasData"
              ? t(($) => {
                  return $.chat.phoneUse.noPhones;
                })
              : t(($) => {
                  return $.chat.phoneUse.loading;
                })}
        </p>
      )}
      <PopoverClose
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-state-hover"
            onClick={() => {
              updateUi({ phoneUseSetupOpen: true });
            }}
          >
            <Plug size={16} className="shrink-0" />
            {t(($) => {
              return $.chat.phoneUse.connectMyPhone;
            })}
          </button>
        }
      />
    </div>
  );
}

export function PhoneUseConnectorMenuSection({
  signals,
}: {
  signals: ComposerConnectorSignals;
}) {
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.PhoneUse];
  return enabled ? <PhoneUseDevices signals={signals} /> : null;
}

export function PhoneUseSetupDialog({
  signals,
  isNewChat,
}: {
  signals: ComposerConnectorSignals;
  isNewChat: boolean;
}) {
  const { t } = useTranslation();
  const open = useGet(signals.phoneUseSetupOpen$);
  const updateUi = useSet(signals.updateConnectorUiState$);
  const trigger = useGet(signals.triggerElement$);
  return (
    <Dialog
      open={open}
      onOpenChange={(phoneUseSetupOpen) => {
        updateUi({ phoneUseSetupOpen });
      }}
    >
      <DialogContent
        maxWidth={480}
        finalFocus={() => {
          return trigger;
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.chat.phoneUse.connectMyPhone;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.chat.phoneUse.setupDescription;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <ol className="list-decimal space-y-4 pl-5 text-sm">
            <li>
              <p className="font-medium">
                {t(($) => {
                  return $.chat.phoneUse.openApp;
                })}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t(($) => {
                  return $.chat.phoneUse.openAppDescription;
                })}
              </p>
            </li>
            <li>
              <p className="font-medium">
                {t(($) => {
                  return $.chat.phoneUse.allowChat;
                })}
              </p>
              <p className="mt-1 text-muted-foreground">
                {isNewChat
                  ? t(($) => {
                      return $.chat.phoneUse.createChatDescription;
                    })
                  : t(($) => {
                      return $.chat.phoneUse.allowChatDescription;
                    })}
              </p>
            </li>
            <li>
              <p className="font-medium">
                {t(($) => {
                  return $.chat.phoneUse.startTask;
                })}
              </p>
              <p className="mt-1 text-muted-foreground">
                {t(($) => {
                  return $.chat.phoneUse.startTaskDescription;
                })}
              </p>
            </li>
          </ol>
        </DialogBody>
        <div className="flex justify-end">
          <DialogClose render={<Button />}>
            {t(($) => {
              return $.chat.phoneUse.done;
            })}
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}
