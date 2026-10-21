import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { KeyRound, ChevronRight, Check } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@okouai/ui";
import {
  remoteLoginPicker$,
  setRemoteLoginPicker$,
  remoteLoginImpact$,
  confirmRemoteLoginSave$,
  cancelRemoteLoginSave$,
  type RemoteLoginProtocol,
} from "../../signals/remote-login.ts";
export function RemoteLoginPicker({
  protocol,
  items,
  choose,
  disabled,
}: {
  readonly protocol: RemoteLoginProtocol;
  readonly items: readonly {
    readonly value: string;
    readonly label: string;
    readonly description: ReactNode;
  }[];
  readonly choose: (value: string) => void;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const open = useGet(remoteLoginPicker$) === protocol;
  const setOpen = useSet(setRemoteLoginPicker$);
  if (!items.length) {
    return null;
  }
  return (
    <>
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="h-auto min-h-9 whitespace-normal text-left text-sm"
        disabled={disabled}
        onClick={() => {
          setOpen(protocol);
        }}
      >
        {t(($) => {
          return $.remoteControlSetup.useSavedLogin;
        })}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value ? protocol : null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(($) => {
                return $.remoteControlSetup.useSavedLogin;
              })}
            </DialogTitle>
            <DialogDescription>
              {t(($) => {
                return $.remoteControlSetup.compatibleLoginOnly;
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {items.map((item) => {
              return (
                <Button
                  type="button"
                  key={item.value}
                  variant="outline"
                  className="h-auto min-h-16 justify-start whitespace-normal p-4 text-left"
                  onClick={() => {
                    choose(item.value);
                    setOpen(null);
                  }}
                >
                  <KeyRound size={18} aria-hidden />
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span>{item.label}</span>
                    <span className="text-sm font-normal text-muted-foreground">
                      {item.description}
                    </span>
                  </span>
                  <ChevronRight size={16} aria-hidden />
                </Button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
export function RemoteLoginConfirmation({
  protocol,
}: {
  readonly protocol: RemoteLoginProtocol;
}) {
  const { t } = useTranslation();
  const impact = useGet(remoteLoginImpact$);
  const confirm = useSet(confirmRemoteLoginSave$);
  const cancel = useSet(cancelRemoteLoginSave$);
  return (
    <Dialog
      open={impact?.protocol === protocol}
      onOpenChange={(open) => {
        if (!open) {
          cancel();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.remoteControlSetup.sharedLoginTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.remoteControlSetup.sharedLoginHelp;
              },
              { connectionCount: impact?.hosts.length ?? 0 },
            )}
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2 rounded-lg bg-gray-50 p-4">
          {impact?.hosts.map((host) => {
            return (
              <li key={host.id} className="text-sm">
                {host.displayName}
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={cancel}>
            {t(($) => {
              return $.remoteControlSetup.continueEditing;
            })}
          </Button>
          <Button
            type="submit"
            form={`remote-${protocol}-edit-form`}
            onClick={() => {
              confirm(protocol);
            }}
          >
            {t(($) => {
              return $.remoteControlSetup.sharedLoginConfirm;
            })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RemoteSelectedLogin({
  label,
  description,
  disabled,
  chooseNew,
}: {
  readonly label: string | undefined;
  readonly description: ReactNode;
  readonly disabled: boolean;
  readonly chooseNew: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-divider bg-gray-50 p-4">
      <Check size={20} className="shrink-0" aria-hidden />
      <div className="grid min-w-0 flex-1 gap-1 break-words">
        <span className="font-medium">{label}</span>
        <span className="text-sm text-muted-foreground">{description}</span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-auto min-h-9 whitespace-normal text-left"
        disabled={disabled}
        onClick={chooseNew}
      >
        {t(($) => {
          return $.remoteControlSetup.newLogin;
        })}
      </Button>
    </div>
  );
}
