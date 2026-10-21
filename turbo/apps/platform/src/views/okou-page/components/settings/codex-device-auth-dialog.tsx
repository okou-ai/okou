import { buttonVariants } from "@okouai/ui/components/ui/button";
import { CopyButton } from "@okouai/ui/components/ui/copy-button";
import { useGet, useLoadable, useSet, type Loadable } from "ccstate-react";
import { useTranslation } from "react-i18next";

import { brandName$ } from "../../../../signals/branding.ts";
import {
  closeCodexDeviceAuthDialogPersonal$,
  codexDeviceAuthDialogStatePersonal$,
  codexDeviceAuthFlowStatePersonal$,
  codexDeviceAuthStartOperationPersonal$,
  codexDeviceAuthRunOperationPersonal$,
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
  startLoadable: Loadable<boolean | null>;
  runLoadable: Loadable<boolean | null>;
  close: (signal: AbortSignal) => Promise<void>;
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
  const run = useSet(runCodexDeviceAuthPersonal$);
  const startLoadable = useLoadable(codexDeviceAuthStartOperationPersonal$);
  const runLoadable = useLoadable(codexDeviceAuthRunOperationPersonal$);
  return {
    dialog,
    flow,
    startLoadable,
    runLoadable,
    close,
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
  const { dialog, flow, startLoadable, runLoadable, close, run } = bundle;
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
        startLoadable={startLoadable}
        runLoadable={runLoadable}
        mode={dialog.mode}
        onStart={() => {
          detach(run(pageSignal), Reason.DomCallback);
        }}
      />
    </DeviceAuthDialogShell>
  );
}

function CodexDeviceAuthBody({
  flow,
  startLoadable,
  runLoadable,
  mode,
  onStart,
}: {
  flow: CodexDeviceAuthFlowState;
  startLoadable: Loadable<boolean | null>;
  runLoadable: Loadable<boolean | null>;
  mode: "connect" | "reconnect";
  onStart: () => void;
}) {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();
  if (startLoadable.state === "loading") {
    return (
      <DeviceAuthLoadingContent
        testId="codex-device-auth-loading"
        label={t(($) => {
          return $.settings.models.deviceAuth.codex.preparing;
        })}
      />
    );
  }
  if (
    startLoadable.state === "hasError" ||
    runLoadable.state === "hasError" ||
    flow.status !== "pending"
  ) {
    return (
      <DeviceAuthRetryContent
        message={
          flow.status === "expired" || flow.status === "error"
            ? flow.message
            : undefined
        }
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
      <a
        href={flow.browserUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({
          variant: "outline",
          className: "w-full",
        })}
        data-testid="codex-device-auth-open"
      >
        {t(($) => {
          return $.settings.models.deviceAuth.codex.openApproval;
        })}
      </a>
    </div>
  );
}
