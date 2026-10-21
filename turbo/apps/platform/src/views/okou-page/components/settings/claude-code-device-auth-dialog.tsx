import { Button, buttonVariants } from "@okouai/ui/components/ui/button";
import { Input } from "@okouai/ui/components/ui/input";
import { useGet, useLoadable, useSet, type Loadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { brandName$ } from "../../../../signals/branding.ts";
import {
  claudeCodeDeviceAuthDialogStatePersonal$,
  claudeCodeDeviceAuthFlowStatePersonal$,
  claudeCodeDeviceAuthStartOperationPersonal$,
  closeClaudeCodeDeviceAuthDialogPersonal$,
  runClaudeCodeDeviceAuthPersonal$,
  setClaudeCodeDeviceAuthAuthorizationCodePersonal$,
  submitClaudeCodeDeviceAuthPersonal$,
  type ClaudeCodeDeviceAuthFlowState,
} from "../../../../signals/okou-page/settings/claude-code-device-auth.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  DeviceAuthDialogShell,
  DeviceAuthLoadingContent,
  DeviceAuthRetryContent,
} from "./device-auth-dialog-shell.tsx";

type ClaudeCodeDeviceAuthDialogState = {
  open: boolean;
  mode: "connect" | "reconnect";
};

interface ClaudeCodeDeviceAuthScopeBundle {
  dialog: ClaudeCodeDeviceAuthDialogState;
  flow: ClaudeCodeDeviceAuthFlowState;
  startLoadable: Loadable<boolean | null>;
  close: (signal: AbortSignal) => Promise<void>;
  run: (signal: AbortSignal) => Promise<boolean>;
  submit: (signal: AbortSignal) => Promise<boolean>;
  submitting: boolean;
  setAuthorizationCode: (value: string) => void;
}

export function PersonalClaudeCodeDeviceAuthDialog() {
  const bundle = usePersonalClaudeCodeDeviceAuthBundle();
  return <ClaudeCodeDeviceAuthDialogView bundle={bundle} />;
}

function usePersonalClaudeCodeDeviceAuthBundle(): ClaudeCodeDeviceAuthScopeBundle {
  const dialog = useGet(claudeCodeDeviceAuthDialogStatePersonal$);
  const flow = useGet(claudeCodeDeviceAuthFlowStatePersonal$);
  const close = useSet(closeClaudeCodeDeviceAuthDialogPersonal$);
  const run = useSet(runClaudeCodeDeviceAuthPersonal$);
  const startLoadable = useLoadable(
    claudeCodeDeviceAuthStartOperationPersonal$,
  );
  const [submitLoadable, submit] = useLoadableSet(
    submitClaudeCodeDeviceAuthPersonal$,
  );
  const setAuthorizationCode = useSet(
    setClaudeCodeDeviceAuthAuthorizationCodePersonal$,
  );
  return {
    dialog,
    flow,
    startLoadable,
    close,
    run,
    submit,
    submitting: submitLoadable.state === "loading",
    setAuthorizationCode,
  };
}

function ClaudeCodeDeviceAuthDialogView({
  bundle,
}: {
  bundle: ClaudeCodeDeviceAuthScopeBundle;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const {
    dialog,
    flow,
    startLoadable,
    close,
    run,
    submit,
    submitting,
    setAuthorizationCode,
  } = bundle;
  const title =
    dialog.mode === "reconnect"
      ? t(($) => {
          return $.settings.models.deviceAuth.claude.reconnectTitle;
        })
      : t(($) => {
          return $.settings.models.deviceAuth.claude.connectTitle;
        });

  return (
    <DeviceAuthDialogShell
      open={dialog.open}
      close={close}
      iconType="claude-code-oauth-token"
      title={title}
    >
      <ClaudeCodeDeviceAuthBody
        flow={flow}
        startLoadable={startLoadable}
        mode={dialog.mode}
        onStart={() => {
          detach(run(pageSignal), Reason.DomCallback);
        }}
        onSubmit={() => {
          detach(submit(pageSignal), Reason.DomCallback);
        }}
        setAuthorizationCode={setAuthorizationCode}
        submitting={submitting}
      />
    </DeviceAuthDialogShell>
  );
}

function ClaudeCodeDeviceAuthBody({
  flow,
  startLoadable,
  mode,
  onStart,
  onSubmit,
  setAuthorizationCode,
  submitting,
}: {
  flow: ClaudeCodeDeviceAuthFlowState;
  startLoadable: Loadable<boolean | null>;
  mode: "connect" | "reconnect";
  onStart: () => void;
  onSubmit: () => void;
  setAuthorizationCode: (value: string) => void;
  submitting: boolean;
}) {
  const { t } = useTranslation();
  if (startLoadable.state === "loading") {
    return (
      <DeviceAuthLoadingContent
        testId="claude-code-device-auth-loading"
        label={t(($) => {
          return $.settings.models.deviceAuth.claude.preparing;
        })}
      />
    );
  }
  if (startLoadable.state === "hasError" || flow.status !== "pending") {
    return (
      <DeviceAuthRetryContent
        message={flow.status === "expired" ? flow.message : undefined}
        testId="claude-code-device-auth-start"
        onStart={onStart}
        label={
          mode === "reconnect"
            ? t(($) => {
                return $.settings.models.deviceAuth.claude.reconnectAction;
              })
            : t(($) => {
                return $.settings.models.deviceAuth.claude.signIn;
              })
        }
      />
    );
  }
  return (
    <ClaudeCodeDeviceAuthPendingForm
      flow={flow}
      onSubmit={onSubmit}
      setAuthorizationCode={setAuthorizationCode}
      submitting={submitting}
    />
  );
}

function ClaudeCodeDeviceAuthPendingForm({
  flow,
  onSubmit,
  setAuthorizationCode,
  submitting,
}: {
  flow: Extract<ClaudeCodeDeviceAuthFlowState, { status: "pending" }>;
  onSubmit: () => void;
  setAuthorizationCode: (value: string) => void;
  submitting: boolean;
}) {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
        <p>
          {t(($) => {
            return $.settings.models.deviceAuth.claude.usageNotice;
          })}
        </p>
        <p>
          {t(
            ($) => {
              return $.settings.models.deviceAuth.claude.instructions;
            },
            { brandName },
          )}
        </p>
      </div>
      <a
        href={flow.browserUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({ variant: "outline", className: "w-full" })}
        data-testid="claude-code-device-auth-open"
      >
        {t(($) => {
          return $.settings.models.deviceAuth.claude.openApproval;
        })}
      </a>
      <div className="flex flex-col gap-2">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="claude-code-device-auth-code"
        >
          {t(($) => {
            return $.settings.models.deviceAuth.claude.authorizationCode;
          })}
        </label>
        <Input
          id="claude-code-device-auth-code"
          value={flow.authorizationCode}
          placeholder={t(($) => {
            return $.settings.models.deviceAuth.claude.codePlaceholder;
          })}
          readOnly={submitting}
          onChange={(event) => {
            setAuthorizationCode(event.target.value);
          }}
          data-testid="claude-code-device-auth-code"
        />
      </div>
      {flow.errorMessage && (
        <p className="text-xs text-destructive" role="alert">
          {flow.errorMessage}
        </p>
      )}
      <Button
        type="submit"
        className="w-full gap-2"
        disabled={submitting}
        data-testid="claude-code-device-auth-submit"
      >
        {submitting && <Loader2 size={14} className="animate-spin" />}
        {submitting
          ? t(($) => {
              return $.settings.shared.connecting;
            })
          : t(($) => {
              return $.settings.models.deviceAuth.claude.submit;
            })}
      </Button>
    </form>
  );
}
