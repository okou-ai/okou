import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui/components/ui/button";
import { Input } from "@okouai/ui/components/ui/input";
import { Loader2 } from "lucide-react";

import {
  claudeCodeDeviceAuthDialogState$,
  claudeCodeDeviceAuthDialogStatePersonal$,
  claudeCodeDeviceAuthFlowState$,
  claudeCodeDeviceAuthFlowStatePersonal$,
  closeClaudeCodeDeviceAuthDialog$,
  closeClaudeCodeDeviceAuthDialogPersonal$,
  openClaudeCodeDeviceAuthApprovalPage$,
  openClaudeCodeDeviceAuthApprovalPagePersonal$,
  runClaudeCodeDeviceAuth$,
  runClaudeCodeDeviceAuthPersonal$,
  setClaudeCodeDeviceAuthAuthorizationCode$,
  setClaudeCodeDeviceAuthAuthorizationCodePersonal$,
  submitClaudeCodeDeviceAuth$,
  submitClaudeCodeDeviceAuthPersonal$,
  type ClaudeCodeDeviceAuthFlowState,
} from "../../../../signals/okou-page/settings/claude-code-device-auth.ts";
import { brandName$ } from "../../../../signals/branding.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
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
  close: (signal: AbortSignal) => Promise<void>;
  openApprovalPage: (signal: AbortSignal) => boolean | Promise<boolean>;
  run: (signal: AbortSignal) => Promise<boolean>;
  submit: (signal: AbortSignal) => Promise<boolean>;
  submitting: boolean;
  setAuthorizationCode: (value: string) => void;
}

export function ClaudeCodeDeviceAuthDialog() {
  const bundle = useOrgClaudeCodeDeviceAuthBundle();
  return <ClaudeCodeDeviceAuthDialogView bundle={bundle} />;
}

export function PersonalClaudeCodeDeviceAuthDialog() {
  const bundle = usePersonalClaudeCodeDeviceAuthBundle();
  return <ClaudeCodeDeviceAuthDialogView bundle={bundle} />;
}

function useOrgClaudeCodeDeviceAuthBundle(): ClaudeCodeDeviceAuthScopeBundle {
  const dialog = useGet(claudeCodeDeviceAuthDialogState$);
  const flow = useGet(claudeCodeDeviceAuthFlowState$);
  const close = useSet(closeClaudeCodeDeviceAuthDialog$);
  const openApprovalPage = useSet(openClaudeCodeDeviceAuthApprovalPage$);
  const [, run] = useLoadableSet(runClaudeCodeDeviceAuth$);
  const [submitLoadable, submit] = useLoadableSet(submitClaudeCodeDeviceAuth$);
  const setAuthorizationCode = useSet(
    setClaudeCodeDeviceAuthAuthorizationCode$,
  );
  return {
    dialog,
    flow,
    close,
    openApprovalPage,
    run,
    submit,
    submitting: submitLoadable.state === "loading",
    setAuthorizationCode,
  };
}

function usePersonalClaudeCodeDeviceAuthBundle(): ClaudeCodeDeviceAuthScopeBundle {
  const dialog = useGet(claudeCodeDeviceAuthDialogStatePersonal$);
  const flow = useGet(claudeCodeDeviceAuthFlowStatePersonal$);
  const close = useSet(closeClaudeCodeDeviceAuthDialogPersonal$);
  const openApprovalPage = useSet(
    openClaudeCodeDeviceAuthApprovalPagePersonal$,
  );
  const [, run] = useLoadableSet(runClaudeCodeDeviceAuthPersonal$);
  const [submitLoadable, submit] = useLoadableSet(
    submitClaudeCodeDeviceAuthPersonal$,
  );
  const setAuthorizationCode = useSet(
    setClaudeCodeDeviceAuthAuthorizationCodePersonal$,
  );
  return {
    dialog,
    flow,
    close,
    openApprovalPage,
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
    close,
    openApprovalPage,
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
        mode={dialog.mode}
        onStart={() => {
          detach(run(pageSignal), Reason.DomCallback);
        }}
        onSubmit={() => {
          detach(submit(pageSignal), Reason.DomCallback);
        }}
        openApprovalPage={openApprovalPage}
        setAuthorizationCode={setAuthorizationCode}
        submitting={submitting}
      />
    </DeviceAuthDialogShell>
  );
}

function ClaudeCodeDeviceAuthBody({
  flow,
  mode,
  onStart,
  onSubmit,
  openApprovalPage,
  setAuthorizationCode,
  submitting,
}: {
  flow: ClaudeCodeDeviceAuthFlowState;
  mode: "connect" | "reconnect";
  onStart: () => void;
  onSubmit: () => void;
  openApprovalPage: (signal: AbortSignal) => boolean | Promise<boolean>;
  setAuthorizationCode: (value: string) => void;
  submitting: boolean;
}) {
  const { t } = useTranslation();
  switch (flow.status) {
    case "idle":
    case "starting": {
      return (
        <DeviceAuthLoadingContent
          testId="claude-code-device-auth-loading"
          label={t(($) => {
            return $.settings.models.deviceAuth.claude.preparing;
          })}
        />
      );
    }
    case "pending": {
      return (
        <ClaudeCodeDeviceAuthPendingForm
          flow={flow}
          onSubmit={onSubmit}
          openApprovalPage={openApprovalPage}
          setAuthorizationCode={setAuthorizationCode}
          submitting={submitting}
        />
      );
    }
    case "expired":
    case "error": {
      return (
        <DeviceAuthRetryContent
          message={flow.message}
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
  }
}

function ClaudeCodeDeviceAuthPendingForm({
  flow,
  onSubmit,
  openApprovalPage,
  setAuthorizationCode,
  submitting,
}: {
  flow: Extract<ClaudeCodeDeviceAuthFlowState, { status: "pending" }>;
  onSubmit: () => void;
  openApprovalPage: (signal: AbortSignal) => boolean | Promise<boolean>;
  setAuthorizationCode: (value: string) => void;
  submitting: boolean;
}) {
  const brandName = useGet(brandName$);
  const pageSignal = useGet(pageSignal$);
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
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => {
          detach(openApprovalPage(pageSignal), Reason.DomCallback);
        }}
        data-testid="claude-code-device-auth-open"
      >
        {t(($) => {
          return $.settings.models.deviceAuth.claude.openApproval;
        })}
      </Button>
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
