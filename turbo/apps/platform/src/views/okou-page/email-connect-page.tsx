import { useGet, useLastLoadable, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  emailConnection$,
  emailConnectParams$,
  emailLinkStatus$,
  disconnectEmail$,
  connectVerifiedEmail$,
  type EmailLinkStatus,
} from "../../signals/okou-page/email.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  PageShell,
  CenterText,
  ConnectCheckingState,
  ConnectErrorState,
  ConnectInvalidLinkState,
  ConnectSuccessState,
  SettingsBackLink,
} from "./connect-page-shell.tsx";

export function EmailConnectPage() {
  return (
    <PageShell>
      <EmailConnectContent />
    </PageShell>
  );
}

function EmailConnectContent() {
  const { t } = useTranslation();
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.EmailIntegration];
  const connection = useLoadable(emailConnection$);
  const params = useGet(emailConnectParams$);
  const status = useLastLoadable(emailLinkStatus$);
  if (!enabled) {
    return (
      <ConnectErrorState
        message={t(($) => {
          return $.works.email.unavailable;
        })}
      />
    );
  }
  if (params && !params.success) {
    return (
      <ConnectInvalidLinkState
        description={t(($) => {
          return $.works.email.invalidLink;
        })}
      />
    );
  }
  if (connection.state === "hasError") {
    return (
      <ConnectErrorState
        message={
          connection.error instanceof Error
            ? connection.error.message
            : t(($) => {
                return $.works.email.loadError;
              })
        }
      />
    );
  }
  if (params && (connection.state !== "hasData" || connection.data === null)) {
    return <ConnectCheckingState />;
  }
  if (connection.state === "hasData" && connection.data !== null) {
    return (
      <ConnectSuccessState
        title={t(($) => {
          return $.works.email.connected;
        })}
        description={t(
          ($) => {
            return $.works.email.resumed;
          },
          {
            email: connection.data.emailAddress,
          },
        )}
        openHref="mailto:okou@okou.io"
        openLabel={t(($) => {
          return $.works.email.open;
        })}
        openIcon={<Mail size={16} />}
      />
    );
  }
  if (status.state === "hasError") {
    return (
      <ConnectErrorState
        message={t(($) => {
          return $.works.email.loadError;
        })}
      />
    );
  }
  if (status.state !== "hasData") {
    return <ConnectCheckingState />;
  }
  if (!status.data.configured) {
    return (
      <ConnectErrorState
        message={t(($) => {
          return $.works.email.unavailable;
        })}
      />
    );
  }
  return <EmailConnectionSettings status={status.data} />;
}

function EmailConnectionSettings({
  status,
}: {
  readonly status: EmailLinkStatus;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Mail size={40} aria-hidden="true" />
      <CenterText
        title={t(($) => {
          return $.works.email.title;
        })}
        body={t(($) => {
          return $.works.email.instructions;
        })}
      />
      <a
        href={`mailto:${status.address}`}
        className="text-sm text-foreground underline underline-offset-4 hover:text-muted-foreground"
      >
        {status.address}
      </a>
      {status.emails.map((email) => {
        return <EmailAddressRow key={email} email={email} connected />;
      })}
      {status.availableEmails
        .filter((email) => {
          return !status.emails.includes(email);
        })
        .map((email) => {
          return (
            <EmailAddressRow key={email} email={email} connected={false} />
          );
        })}
      <p className="text-center text-xs text-muted-foreground">
        {t(($) => {
          return $.works.email.healthNotice;
        })}
      </p>
      <SettingsBackLink />
    </>
  );
}

function EmailAddressRow({
  email,
  connected,
}: {
  readonly email: string;
  readonly connected: boolean;
}) {
  const { t } = useTranslation();
  const [operation, execute] = useLoadableSet(
    connected ? disconnectEmail$ : connectVerifiedEmail$,
  );
  const signal = useGet(pageSignal$);
  return (
    <div className="w-full space-y-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{email}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={operation.state === "loading"}
          onClick={() => {
            detach(execute(email, signal), Reason.DomCallback);
          }}
        >
          {operation.state === "loading" ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : null}
          {t(($) => {
            return connected
              ? $.connectors.actions.disconnect
              : $.connectors.actions.connect;
          })}
        </Button>
      </div>
      {operation.state === "hasError" ? (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.works.email.loadError;
          })}
        </p>
      ) : null}
    </div>
  );
}
