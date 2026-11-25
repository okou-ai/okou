import { Button, buttonVariants } from "@okouai/ui/components/ui/button";
import { Input } from "@okouai/ui/components/ui/input";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  antigravitySignInAddress$,
  antigravitySignInDialog$,
  antigravitySignInError$,
  antigravitySignInSession$,
  antigravitySignInStart$,
  closeAntigravitySignIn$,
  restartAntigravitySignIn$,
  setAntigravitySignInAddress$,
  submitAntigravitySignIn$,
} from "../../../../signals/okou-page/settings/antigravity-device-auth.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  DeviceAuthDialogShell,
  DeviceAuthLoadingContent,
  DeviceAuthStartContent,
} from "./device-auth-dialog-shell.tsx";

export function AntigravitySignInDialog() {
  const { t } = useTranslation();
  const dialog = useGet(antigravitySignInDialog$);
  const close = useSet(closeAntigravitySignIn$);
  const title =
    dialog?.mode === "reconnect"
      ? t(($) => {
          return $.settings.models.deviceAuth.antigravity.reconnectTitle;
        })
      : t(($) => {
          return $.settings.models.deviceAuth.antigravity.connectTitle;
        });
  return (
    <DeviceAuthDialogShell
      open={dialog !== null}
      close={close}
      iconType="antigravity"
      title={title}
    >
      <AntigravitySignInBody reconnect={dialog?.mode === "reconnect"} />
    </DeviceAuthDialogShell>
  );
}

function AntigravitySignInBody({ reconnect }: { readonly reconnect: boolean }) {
  const { t } = useTranslation();
  const start = useLoadable(antigravitySignInStart$);
  const session = useGet(antigravitySignInSession$);
  const error = useGet(antigravitySignInError$);
  const restart = useSet(restartAntigravitySignIn$);
  const pageSignal = useGet(pageSignal$);
  if (start.state === "loading") {
    return (
      <DeviceAuthLoadingContent
        testId="antigravity-sign-in-loading"
        label={t(($) => {
          return $.settings.models.deviceAuth.antigravity.preparing;
        })}
      />
    );
  }
  if (start.state === "hasError" || !session) {
    return (
      <DeviceAuthStartContent
        message={
          error ??
          (start.state === "hasError"
            ? t(($) => {
                return $.settings.models.deviceAuth.antigravity.failed;
              })
            : undefined)
        }
        testId="antigravity-sign-in-start"
        onStart={() => {
          detach(restart(pageSignal), Reason.DomCallback);
        }}
        label={
          reconnect
            ? t(($) => {
                return $.settings.models.deviceAuth.antigravity.reconnectAction;
              })
            : t(($) => {
                return $.settings.models.deviceAuth.antigravity.signIn;
              })
        }
      />
    );
  }
  return <AntigravitySignInForm browserUrl={session.browserUrl} />;
}

function AntigravitySignInForm({
  browserUrl,
}: {
  readonly browserUrl: string;
}) {
  const { t } = useTranslation();
  const address = useGet(antigravitySignInAddress$);
  const error = useGet(antigravitySignInError$);
  const setAddress = useSet(setAntigravitySignInAddress$);
  const [submission, submit] = useLoadableSet(submitAntigravitySignIn$);
  const pageSignal = useGet(pageSignal$);
  const submitting = submission.state === "loading";
  const message =
    error ??
    (submission.state === "hasError"
      ? t(($) => {
          return $.settings.models.deviceAuth.antigravity.failed;
        })
      : null);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        // The dialog submits through the API, not a page navigation.
        event.preventDefault();
        detach(submit(pageSignal), Reason.DomCallback);
      }}
    >
      <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
        <p>
          {t(($) => {
            return $.settings.models.deviceAuth.antigravity.usageNotice;
          })}
        </p>
        <p>
          {t(($) => {
            return $.settings.models.deviceAuth.antigravity.instructions;
          })}
        </p>
      </div>
      <a
        href={browserUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={buttonVariants({ variant: "outline", className: "w-full" })}
      >
        {t(($) => {
          return $.settings.models.deviceAuth.antigravity.openApproval;
        })}
      </a>
      <div className="flex flex-col gap-2">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="antigravity-sign-in-address"
        >
          {t(($) => {
            return $.settings.models.deviceAuth.antigravity.address;
          })}
        </label>
        <Input
          id="antigravity-sign-in-address"
          value={address}
          placeholder={t(($) => {
            return $.settings.models.deviceAuth.antigravity.addressPlaceholder;
          })}
          readOnly={submitting}
          onChange={(event) => {
            setAddress(event.target.value);
          }}
        />
      </div>
      {message && (
        <p className="text-xs text-destructive" role="alert">
          {message}
        </p>
      )}
      <Button type="submit" className="w-full gap-2" disabled={submitting}>
        {submitting && <Loader2 size={14} className="animate-spin" />}
        {submitting
          ? t(($) => {
              return $.settings.shared.connecting;
            })
          : t(($) => {
              return $.settings.models.deviceAuth.antigravity.submit;
            })}
      </Button>
    </form>
  );
}
