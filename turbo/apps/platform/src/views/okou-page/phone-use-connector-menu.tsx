import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Plug, Smartphone } from "lucide-react";
import {
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
import { pageSignal$ } from "../../signals/page-signal.ts";
import { onDomEventFn } from "../../signals/utils.ts";
import { LoadingSwitch } from "../components/loading-switch.tsx";

function PhoneRow({
  device,
  signals,
}: {
  readonly device: PhoneDevice;
  readonly signals: ComposerConnectorSignals;
}) {
  const { t } = useTranslation();
  const selection = useLoadable(signals.phoneAccess.selection$);
  const lastSelection = useLastResolved(signals.phoneAccess.selection$);
  const saving = useLoadable(signals.phoneAccess.saving$);
  const setDevice = useSet(signals.phoneAccess.setDevice$);
  const signal = useGet(pageSignal$);
  const selected =
    selection.state === "hasData" ? selection.data : lastSelection;
  const checked =
    selected?.deviceId === device.id &&
    selected.generation === device.generation;
  return (
    <li>
      <label className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-state-hover">
        <Smartphone size={16} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-sm text-foreground"
            title={device.displayName}
          >
            {device.displayName}
          </span>
          {!device.online && (
            <span className="block text-xs text-muted-foreground">
              {t(($) => {
                return $.chat.computerUse.offline;
              })}
            </span>
          )}
        </span>
        <LoadingSwitch
          checked={checked}
          disabled={
            selection.state !== "hasData" || (!checked && !device.online)
          }
          loading={saving.state === "loading"}
          onCheckedChange={onDomEventFn(async (allow) => {
            await setDevice(
              { deviceId: device.id, generation: device.generation },
              allow,
              signal,
            );
          })}
          size="sm"
        />
      </label>
    </li>
  );
}

function PhoneUseDevices({ signals }: { signals: ComposerConnectorSignals }) {
  const { t } = useTranslation();
  const devices = useLoadable(signals.resources.phoneUseDevices$);
  const lastDevices = useLastResolved(signals.resources.phoneUseDevices$);
  const selection = useLoadable(signals.phoneAccess.selection$);
  const lastSelection = useLastResolved(signals.phoneAccess.selection$);
  const selected =
    selection.state === "hasData" ? selection.data : lastSelection;
  const visibleDevices = (
    devices.state === "hasData" ? devices.data : (lastDevices ?? [])
  ).filter((device) => {
    return device.online || device.id === selected?.deviceId;
  });
  const updateUi = useSet(signals.updateConnectorUiState$);
  return (
    <div className="shrink-0 border-t border-border/50 bg-gray-50 p-1 dark:bg-gray-100">
      <div className="px-2 pb-1 pt-1 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.phoneUse.yourPhone;
        })}
      </div>
      {visibleDevices.length > 0 ? (
        <ul
          className="flex max-h-[96px] flex-col overflow-y-auto"
          aria-label={t(($) => {
            return $.chat.phoneUse.yourPhone;
          })}
        >
          {visibleDevices.map((device) => {
            return (
              <PhoneRow key={device.id} device={device} signals={signals} />
            );
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
      {(selection.state === "hasError" ||
        (devices.state === "hasError" && visibleDevices.length > 0)) && (
        <p className="px-2 py-1.5 text-xs text-destructive" role="alert">
          {t(($) => {
            return $.chat.phoneUse.loadError;
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
}: {
  signals: ComposerConnectorSignals;
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
                {t(($) => {
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
