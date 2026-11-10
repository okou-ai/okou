import { useGet, useLoadable } from "ccstate-react";
import { Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  emailConnection$,
  emailConnectParams$,
} from "../../signals/okou-page/email.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  PageShell,
  ConnectCheckingState,
  ConnectErrorState,
  ConnectInvalidLinkState,
  ConnectSuccessState,
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
  return <ConnectCheckingState />;
}
