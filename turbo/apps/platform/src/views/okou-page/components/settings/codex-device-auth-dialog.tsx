import { Button } from "@okouai/ui/components/ui/button";
import { CopyButton } from "@okouai/ui/components/ui/copy-button";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import { brandName$ } from "../../../../signals/branding.ts";
import {
  closeCodexDeviceAuthDialogPersonal$,
  codexDeviceAuthDialogStatePersonal$,
  codexDeviceAuthFlowStatePersonal$,
  openCodexDeviceAuthApprovalPagePersonal$,
  runCodexDeviceAuthPersonal$,
  type CodexDeviceAuthFlowState,
} from "../../../../signals/okou-page/settings/codex-device-auth.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  DeviceAuthDialogShell,
  DeviceAuthLoadingContent,
  DeviceAuthRetryContent,
} from "./device-auth-dialog-shell.tsx";

type CodexDeviceAuthDialogState = {
  open: boolean;
  mode: "connect" | "reconnect";
};

interface CodexDeviceAuthScopeBundle {
  dialog: CodexDeviceAuthDialogState;
  flow: CodexDeviceAuthFlowState;
  close: (signal: AbortSignal) => Promise<void>;
  openApprovalPage: (signal: AbortSignal) => Promise<boolean>;
  run: (signal: AbortSignal) => Promise<boolean>;
}

export function PersonalCodexDeviceAuthDialog() {
  const bundle = usePersonalCodexDeviceAuthBundle();
  return <CodexDeviceAuthDialogView bundle={bundle} />;
}

function usePersonalCodexDeviceAuthBundle(): CodexDeviceAuthScopeBundle {
  const dialog = useGet(codexDeviceAuthDialogStatePersonal$);
  const flow = useGet(codexDeviceAuthFlowStatePersonal$);
  const close = useSet(closeCodexDeviceAuthDialogPersonal$);
  const openApprovalPage = useSet(openCodexDeviceAuthApprovalPagePersonal$);
  const [, run] = useLoadableSet(runCodexDeviceAuthPersonal$);
  return {
    dialog,
    flow,
    close,
    openApprovalPage,
    run,
  };
}

function CodexDeviceAuthDialogView({
  bundle,
}: {
  bundle: CodexDeviceAuthScopeBundle;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const { dialog, flow, close, openApprovalPage, run } = bundle;
  const title =
    dialog.mode === "reconnect"
      ? t(($) => {
          return $.settings.models.deviceAuth.codex.reconnectTitle;
        })
      : t(($) => {
          return $.settings.models.deviceAuth.codex.connectTitle;
        });

  return (
    <DeviceAuthDialogShell
      open={dialog.open}
      close={close}
      iconType="codex-oauth-token"
      title={title}
    >
      <CodexDeviceAuthBody
        flow={flow}
        mode={dialog.mode}
        onStart={() => {
          detach(run(pageSignal), Reason.DomCallback);
        }}
        openApprovalPage={openApprovalPage}
      />
    </DeviceAuthDialogShell>
  );
}

function CodexDeviceAuthBody({
  flow,
  mode,
  onStart,
  openApprovalPage,
}: {
  flow: CodexDeviceAuthFlowState;
  mode: "connect" | "reconnect";
  onStart: () => void;
  openApprovalPage: (signal: AbortSignal) => Promise<boolean>;
}) {
  const brandName = useGet(brandName$);
  const pageSignal = useGet(pageSignal$);
  const { t } = useTranslation();
  switch (flow.status) {
    case "idle":
    case "starting": {
      return (
        <DeviceAuthLoadingContent
          testId="codex-device-auth-loading"
          label={t(($) => {
            return $.settings.models.deviceAuth.codex.preparing;
          })}
        />
      );
    }
    case "pending":
    case "polling": {
      const statusText =
        !flow.approvalOpened && !flow.codeCopied
          ? null
          : flow.codeCopied && !flow.approvalOpened
            ? t(($) => {
                return $.settings.models.deviceAuth.codex.codeCopiedRetry;
              })
            : !flow.codeCopied
              ? t(($) => {
                  return $.settings.models.deviceAuth.codex.approvalOpened;
                })
              : t(($) => {
                  return $.settings.models.deviceAuth.codex.codeCopied;
                });
      return (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
            <p>
              {t(
                ($) => {
                  return $.settings.models.deviceAuth.codex.instructions;
                },
                { brandName },
              )}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                  {t(($) => {
                    return $.settings.models.deviceAuth.codex.deviceCode;
                  })}
                </p>
                <p
                  className="mt-1 font-mono text-2xl font-semibold tracking-normal"
                  data-testid="codex-device-auth-code"
                >
                  {flow.verificationCode}
                </p>
              </div>
              <CopyButton
                type="button"
                text={flow.verificationCode}
                className="-m-1 p-1.5 hover:bg-state-hover"
              />
            </div>
          </div>
          {flow.errorMessage && (
            <p className="text-xs text-destructive" role="alert">
              {flow.errorMessage}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => {
              detach(openApprovalPage(pageSignal), Reason.DomCallback);
            }}
            data-testid="codex-device-auth-open"
          >
            {t(($) => {
              return $.settings.models.deviceAuth.codex.copyAndOpen;
            })}
          </Button>
          {statusText && (
            <p className="text-xs text-muted-foreground" role="status">
              {statusText}
            </p>
          )}
        </div>
      );
    }
    case "expired":
    case "error": {
      return (
        <DeviceAuthRetryContent
          message={flow.message}
          testId="codex-device-auth-start"
          onStart={onStart}
          label={
            mode === "reconnect"
              ? t(($) => {
                  return $.settings.models.deviceAuth.codex.reconnectAction;
                })
              : t(($) => {
                  return $.settings.models.deviceAuth.codex.signIn;
                })
          }
        />
      );
    }
  }
}
