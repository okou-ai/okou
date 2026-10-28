import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  agentPhoneConnectStatus$,
  connectAgentPhoneAccount$,
} from "../../signals/okou-page/agentphone-connect-signals.ts";
import {
  isUnreliableAgentPhoneConnectChannel,
  parseAgentPhoneConnectParams,
} from "../../signals/okou-page/agentphone-connect-params.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { AgentPhoneCard } from "./agentphone-card.tsx";
import {
  CenterText,
  ConnectBackLink,
  ConnectErrorAlert,
  ConnectCheckingState,
  ConnectErrorState,
  ConnectStatusMark,
  ConnectSubmitButton,
  PageShell,
  connectErrorMessage,
  type MarkState,
} from "./connect-page-shell.tsx";

const imessageIconImg = settingsIconAssetUrl("imessage");

function BackLink() {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();

  return (
    <ConnectBackLink
      pathname="/works"
      label={t(
        ($) => {
          return $.connectors.providerConnect.agentphone.back;
        },
        { brandName },
      )}
    />
  );
}

function MessageMark({ state }: { state?: MarkState }) {
  return (
    <ConnectStatusMark
      state={state}
      idle={
        <span className="shrink-0 inline-flex h-10 w-10 items-center justify-center overflow-hidden">
          <img
            src={imessageIconImg}
            alt=""
            className="h-10 w-10"
            data-testid="agentphone-connect-icon"
          />
        </span>
      }
    />
  );
}

function InvalidState({ title, message }: { title: string; message: string }) {
  return (
    <PageShell>
      <MessageMark state="error" />
      <CenterText title={title} body={message} />
      <BackLink />
    </PageShell>
  );
}

function SmsMmsRiskNotice({ channel }: { channel: string | null }) {
  const { t } = useTranslation();
  if (!isUnreliableAgentPhoneConnectChannel(channel)) {
    return null;
  }

  return (
    <div className="w-full rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
      {t(($) => {
        return $.connectors.providerConnect.agentphone.risk;
      })}
    </div>
  );
}

function AgentPhoneInvalidLink({
  code,
}: {
  code: "incomplete" | "invalid_signature" | "invalid_timestamp";
}) {
  const { t } = useTranslation();
  const invalidTitle =
    code === "incomplete"
      ? t(($) => {
          return $.connectors.providerConnect.agentphone.incompleteTitle;
        })
      : t(($) => {
          return $.connectors.providerConnect.agentphone.invalidTitle;
        });
  const invalidMessage =
    code === "incomplete"
      ? t(($) => {
          return $.connectors.providerConnect.agentphone.incompleteDescription;
        })
      : code === "invalid_timestamp"
        ? t(($) => {
            return $.connectors.providerConnect.agentphone.invalidTimestamp;
          })
        : t(($) => {
            return $.connectors.providerConnect.agentphone.invalidSignature;
          });
  return <InvalidState title={invalidTitle} message={invalidMessage} />;
}

function AgentPhoneOverview() {
  const { t } = useTranslation();
  return (
    <PageShell>
      <MessageMark />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.agentphone.connectTitle;
        })}
        body={t(($) => {
          return $.connectors.providerSettings.agentphone.description;
        })}
      />
      <AgentPhoneCard />
      <BackLink />
    </PageShell>
  );
}

function AgentPhoneSuccess({
  phone,
  channel,
}: {
  phone: string;
  channel: string | null;
}) {
  const { t } = useTranslation();
  return (
    <PageShell>
      <MessageMark state="success" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.agentphone.successTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.agentphone.successDescription;
          },
          { phone },
        )}
      />
      <SmsMmsRiskNotice channel={channel} />
      <BackLink />
    </PageShell>
  );
}

function PhoneMismatchState({
  currentPhone,
  requestedPhone,
  channel,
  connecting,
  error,
  onSwitch,
}: {
  currentPhone: string;
  requestedPhone: string;
  channel: string | null;
  connecting: boolean;
  error: string | null;
  onSwitch: () => void;
}) {
  const { t } = useTranslation();
  return (
    <PageShell>
      <MessageMark state={connecting ? "loading" : "warning"} />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.agentphone.phoneMismatchTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.agentphone
              .phoneMismatchDescription;
          },
          {
            currentPhone,
            requestedPhone,
          },
        )}
      />
      <SmsMmsRiskNotice channel={channel} />
      <ConnectErrorAlert error={error} />
      <ConnectSubmitButton
        connecting={connecting}
        label={t(
          ($) => {
            return $.connectors.providerConnect.agentphone.switchPhone;
          },
          { phone: requestedPhone },
        )}
        onConnect={onSwitch}
      />
      <ConnectBackLink
        pathname="/works"
        label={t(
          ($) => {
            return $.connectors.providerConnect.agentphone.keepPhone;
          },
          { phone: currentPhone },
        )}
      />
    </PageShell>
  );
}

export function AgentPhoneConnectPage(): JSX.Element {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const params = useGet(searchParams$);
  const parsed = parseAgentPhoneConnectParams(params);
  const statusLoadable = useLoadable(agentPhoneConnectStatus$);
  const [connectLoadable, connectAgentPhone] = useLoadableSet(
    connectAgentPhoneAccount$,
  );
  const pageSignal = useGet(pageSignal$);
  const connecting = connectLoadable.state === "loading";
  const success =
    connectLoadable.state === "hasData" ? connectLoadable.data : null;
  const error =
    connectLoadable.state === "hasError"
      ? connectErrorMessage(
          connectLoadable.error,
          i18n.t(($) => {
            return $.connectors.providerConnect.agentphone.errorFallback;
          }),
        )
      : null;

  if (
    !["handle", "agent", "ts", "sig", "channel"].some((key) => {
      return params.has(key);
    })
  ) {
    return <AgentPhoneOverview />;
  }

  if (!parsed.ok) {
    return <AgentPhoneInvalidLink code={parsed.error.code} />;
  }

  if (statusLoadable.state === "hasError") {
    return (
      <PageShell>
        <ConnectErrorState
          message={connectErrorMessage(
            statusLoadable.error,
            t(($) => {
              return $.connectors.providerConnect.agentphone.errorFallback;
            }),
          )}
        />
      </PageShell>
    );
  }

  if (statusLoadable.state !== "hasData" || !statusLoadable.data) {
    return (
      <PageShell>
        <ConnectCheckingState />
      </PageShell>
    );
  }

  const status = statusLoadable.data;
  const connectedPhone =
    success?.phoneHandle ??
    (status.kind === "connected" ? status.phoneHandle : null);
  if (connectedPhone) {
    return (
      <AgentPhoneSuccess phone={connectedPhone} channel={parsed.channel} />
    );
  }

  if (status.kind === "phone_in_use") {
    return (
      <PageShell>
        <MessageMark state="error" />
        <CenterText
          title={t(($) => {
            return $.connectors.providerConnect.agentphone.phoneInUseTitle;
          })}
          body={t(($) => {
            return $.connectors.providerConnect.agentphone
              .phoneInUseDescription;
          })}
        />
        <BackLink />
      </PageShell>
    );
  }

  if (status.kind === "phone_mismatch") {
    return (
      <PhoneMismatchState
        currentPhone={status.currentPhoneHandle}
        requestedPhone={parsed.params.phoneHandle}
        channel={parsed.channel}
        connecting={connecting}
        error={error}
        onSwitch={() => {
          detach(
            connectAgentPhone(status.currentPhoneHandle, pageSignal),
            Reason.DomCallback,
          );
        }}
      />
    );
  }

  return (
    <PageShell>
      <MessageMark state={connecting ? "loading" : "idle"} />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.agentphone.connectTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.agentphone.connectDescription;
          },
          { brandName },
        )}
      />
      <SmsMmsRiskNotice channel={parsed.channel} />
      <ConnectErrorAlert error={error} />
      <ConnectSubmitButton
        connecting={connecting}
        onConnect={() => {
          detach(connectAgentPhone(undefined, pageSignal), Reason.DomCallback);
        }}
      />
      <BackLink />
    </PageShell>
  );
}
