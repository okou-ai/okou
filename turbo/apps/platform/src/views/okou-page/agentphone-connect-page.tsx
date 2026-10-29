import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  agentPhoneConnectStatus$,
  isWhatsappConnectPage$,
  phoneConnectionLinkStatus$,
  connectAgentPhoneAccount$,
} from "../../signals/okou-page/agentphone-connect-signals.ts";
import {
  isUnreliableAgentPhoneConnectChannel,
  parseAgentPhoneConnectParams,
} from "../../signals/okou-page/agentphone-connect-params.ts";
import {
  agentPhoneLinkStatus$,
  createAgentPhoneLinkCode$,
  setAgentPhoneConnectDialogOpen$,
} from "../../signals/okou-page/agentphone.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { INTEGRATION_SETTINGS_PATHS } from "@okouai/core/integration-routes";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { Dialog } from "@okouai/ui/components/ui/dialog";
import { WhatsappMark } from "./components/whatsapp-mark.tsx";
import { WhatsappConnectContent } from "./whatsapp-card.tsx";
import {
  whatsappLinkStatus$,
  whatsappConnectDialogOpen$,
  setWhatsappConnectDialogOpen$,
  openWhatsappConnection$,
} from "../../signals/okou-page/whatsapp.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import { AgentPhoneConnectDialog } from "./agentphone-connect-dialog.tsx";
import {
  CenterText,
  ConnectActionGroup,
  ConnectErrorAlert,
  ConnectCheckingState,
  ConnectErrorState,
  ConnectInvalidLinkState,
  ConnectStatusMark,
  ConnectSubmitButton,
  ConnectSuccessState,
  PageShell,
  SettingsBackLink,
  connectErrorMessage,
  type MarkState,
} from "./connect-page-shell.tsx";

const imessageIconImg = settingsIconAssetUrl("imessage");

function MessageIcon({ size = 40 }: { size?: number }) {
  const whatsapp = useGet(isWhatsappConnectPage$);
  return whatsapp ? (
    <WhatsappMark size={size} className="text-green-600" />
  ) : (
    <img src={imessageIconImg} alt="" width={size} height={size} />
  );
}

function MessageMark({ state }: { state?: MarkState }) {
  return <ConnectStatusMark state={state} idle={<MessageIcon />} />;
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

function AgentPhoneSuccess({
  phone,
  channel,
}: {
  phone: string;
  channel: string | null;
}) {
  const { t } = useTranslation();
  const whatsapp = useGet(isWhatsappConnectPage$);
  const status = useLoadable(phoneConnectionLinkStatus$);
  if (status.state === "hasError") {
    return (
      <ConnectErrorState
        message={connectErrorMessage(
          status.error,
          t(($) => {
            return $.connectors.providerConnect.agentphone.errorFallback;
          }),
        )}
      />
    );
  }
  if (status.state !== "hasData") {
    return <ConnectCheckingState />;
  }
  const number = status.data.agentPhoneNumber;
  return (
    <ConnectSuccessState
      title={t(($) => {
        return whatsapp
          ? $.works.whatsapp.connected
          : $.connectors.providerConnect.agentphone.successTitle;
      })}
      description={t(
        ($) => {
          return whatsapp
            ? $.works.whatsapp.successDescription
            : $.connectors.providerConnect.agentphone.successDescription;
        },
        { phone },
      )}
      openHref={
        number
          ? whatsapp
            ? `https://wa.me/${number.replace(/^\+/u, "")}`
            : `sms:${number}`
          : null
      }
      openLabel={t(($) => {
        return whatsapp
          ? $.works.whatsapp.open
          : $.connectors.providerSettings.agentphone.openMessages;
      })}
      openIcon={<MessageIcon size={16} />}
      notice={<SmsMmsRiskNotice channel={channel} />}
    />
  );
}

function AgentPhoneOverview() {
  const { t } = useTranslation();
  const status = useLoadable(agentPhoneLinkStatus$);
  const [codeLoadable, createCode] = useLoadableSet(createAgentPhoneLinkCode$);
  const pageSignal = useGet(pageSignal$);
  const setOpen = useSet(setAgentPhoneConnectDialogOpen$);
  if (status.state === "hasError") {
    return (
      <ConnectErrorState
        message={connectErrorMessage(
          status.error,
          t(($) => {
            return $.connectors.providerConnect.agentphone.errorFallback;
          }),
        )}
      />
    );
  }
  if (status.state !== "hasData") {
    return <ConnectCheckingState />;
  }
  if (status.data.linked) {
    return <AgentPhoneSuccess phone={status.data.phoneHandle} channel={null} />;
  }
  const number = status.data.agentPhoneNumber;
  return (
    <>
      <MessageMark />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.agentphone.connectTitle;
        })}
        body={t(($) => {
          return $.connectors.providerSettings.agentphone.description;
        })}
      />
      {status.data.configured && number ? (
        <ConnectSubmitButton
          connecting={codeLoadable.state === "loading"}
          spinnerClassName="animate-spin mr-2"
          onConnect={() => {
            detach(createCode(pageSignal), Reason.DomCallback);
            setOpen(true);
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.providerConnect.agentphone.unavailable;
          })}
        </p>
      )}
      <SettingsBackLink />
      <AgentPhoneConnectDialog
        phoneNumber={number}
        connectionCode={
          codeLoadable.state === "hasData" ? codeLoadable.data : null
        }
        connectionCodeFailed={codeLoadable.state === "hasError"}
      />
    </>
  );
}

function WhatsappOverview() {
  const { t } = useTranslation();
  const status = useLoadable(whatsappLinkStatus$);
  const [codeLoadable, createCode] = useLoadableSet(openWhatsappConnection$);
  const signal = useGet(pageSignal$);
  const open = useGet(whatsappConnectDialogOpen$);
  const setOpen = useSet(setWhatsappConnectDialogOpen$);
  const generateCode = () => {
    detach(createCode(signal), Reason.DomCallback);
  };
  if (status.state === "hasError") {
    return (
      <ConnectErrorState
        message={connectErrorMessage(
          status.error,
          t(($) => {
            return $.works.whatsapp.codeError;
          }),
        )}
      />
    );
  }
  if (status.state !== "hasData") {
    return <ConnectCheckingState />;
  }
  if (status.data.linked) {
    return (
      <AgentPhoneSuccess phone={status.data.phoneHandle} channel="whatsapp" />
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <MessageMark />
      <CenterText
        title={t(($) => {
          return $.works.whatsapp.connect;
        })}
        body={t(($) => {
          return $.works.whatsapp.description;
        })}
      />
      {status.data.configured ? (
        <ConnectSubmitButton
          connecting={codeLoadable.state === "loading"}
          onConnect={generateCode}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.works.whatsapp.unavailable;
          })}
        </p>
      )}
      <SettingsBackLink />
      <WhatsappConnectContent
        phone={status.data.agentPhoneNumber}
        code={codeLoadable.state === "hasData" ? codeLoadable.data : null}
        loading={codeLoadable.state === "loading"}
        failed={codeLoadable.state === "hasError"}
        onGenerate={generateCode}
      />
    </Dialog>
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
    <>
      <MessageMark state="warning" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.agentphone.phoneMismatchTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.agentphone
              .phoneMismatchDescription;
          },
          { currentPhone, requestedPhone },
        )}
      />
      <SmsMmsRiskNotice channel={channel} />
      <ConnectErrorAlert error={error} />
      <ConnectActionGroup
        primary={
          <ConnectSubmitButton
            connecting={connecting}
            label={t(
              ($) => {
                return $.connectors.providerConnect.agentphone.switchPhone;
              },
              { phone: requestedPhone },
            )}
            onConnect={onSwitch}
            spinnerClassName="animate-spin mr-2"
          />
        }
        secondary={
          <SettingsBackLink
            label={t(
              ($) => {
                return $.connectors.providerConnect.agentphone.keepPhone;
              },
              { phone: currentPhone },
            )}
          />
        }
      />
    </>
  );
}

function PhoneInUseState() {
  const { t } = useTranslation();
  return (
    <>
      <MessageMark state="error" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.agentphone.phoneInUseTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.agentphone.phoneInUseDescription;
        })}
      />
      <SettingsBackLink />
    </>
  );
}

export function AgentPhoneConnectPage() {
  return (
    <PageShell>
      <PageContent />
    </PageShell>
  );
}

function PageContent() {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const params = useGet(searchParams$);
  const whatsapp = useGet(isWhatsappConnectPage$);
  const enabled = useGet(featureSwitch$)[FeatureSwitchKey.WhatsappIntegration];
  const parsed = parseAgentPhoneConnectParams(
    params,
    whatsapp
      ? INTEGRATION_SETTINGS_PATHS.whatsapp
      : INTEGRATION_SETTINGS_PATHS.agentphone,
  );
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
          t(($) => {
            return $.connectors.providerConnect.agentphone.errorFallback;
          }),
        )
      : null;
  if (whatsapp && !enabled) {
    return (
      <ConnectErrorState
        message={t(($) => {
          return $.works.whatsapp.unavailable;
        })}
      />
    );
  }
  if (
    !["handle", "agent", "ts", "sig", "channel"].some((key) => {
      return params.has(key);
    })
  ) {
    return whatsapp ? <WhatsappOverview /> : <AgentPhoneOverview />;
  }
  if (!parsed.ok) {
    return <ConnectInvalidLinkState description={parsed.error.message} />;
  }
  if (statusLoadable.state === "hasError") {
    return (
      <ConnectErrorState
        message={connectErrorMessage(
          statusLoadable.error,
          t(($) => {
            return $.connectors.providerConnect.agentphone.errorFallback;
          }),
        )}
      />
    );
  }
  if (statusLoadable.state !== "hasData" || !statusLoadable.data) {
    return <ConnectCheckingState />;
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
    return <PhoneInUseState />;
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
    <>
      <MessageMark />
      <CenterText
        title={t(($) => {
          return whatsapp
            ? $.works.whatsapp.connect
            : $.connectors.providerConnect.agentphone.connectTitle;
        })}
        body={t(
          ($) => {
            return whatsapp
              ? $.works.whatsapp.connectDescription
              : $.connectors.providerConnect.agentphone.connectDescription;
          },
          { brandName },
        )}
      />
      <SmsMmsRiskNotice channel={parsed.channel} />
      <ConnectErrorAlert error={error} />
      <ConnectSubmitButton
        connecting={connecting}
        spinnerClassName="animate-spin mr-2"
        onConnect={() => {
          detach(connectAgentPhone(undefined, pageSignal), Reason.DomCallback);
        }}
      />
      <SettingsBackLink />
    </>
  );
}
