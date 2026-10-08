import { useGet, useLastLoadable, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { JSX } from "react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";
import { clerk$ } from "../../signals/auth.ts";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { searchParams$ } from "../../signals/route.ts";
import {
  connectTelegramAccount$,
  telegramConnectLinkStatus$,
} from "../../signals/okou-page/telegram-connect-signals.ts";
import {
  parseTelegramConnectParams,
  type TelegramConnectParams,
} from "../../signals/okou-page/telegram-connect-params.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";
import {
  CenterText,
  ConnectBackLink,
  ConnectErrorAlert,
  ConnectSignInState,
  ConnectStatusMark,
  ConnectSubmitButton,
  PageShell,
  connectErrorMessage,
  type MarkState,
} from "./connect-page-shell.tsx";

const telegramIconImg = settingsIconAssetUrl("telegram");

function BackLink() {
  const { t } = useTranslation();
  return (
    <ConnectBackLink
      pathname="/settings/telegram"
      label={t(($) => {
        return $.connectors.providerConnect.telegram.back;
      })}
    />
  );
}

function TelegramMark({ state }: { state?: MarkState }) {
  return (
    <ConnectStatusMark
      state={state}
      idle={
        <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-[#2AABEE]/10">
          <img src={telegramIconImg} alt="" className="h-8 w-8" />
        </span>
      }
    />
  );
}

function InvalidState({ title, message }: { title: string; message: string }) {
  return (
    <PageShell>
      <TelegramMark state="error" />
      <CenterText title={title} body={message} />
      <BackLink />
    </PageShell>
  );
}

function SuccessState({ botUsername }: { botUsername: string }) {
  const { t } = useTranslation();
  const telegramHref = `tg://resolve?domain=${botUsername.replace(/^@/, "")}`;
  const botLabel = `@${botUsername.replace(/^@/, "")}`;

  return (
    <PageShell>
      <TelegramMark state="success" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.successTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.telegram.successDescription;
          },
          { bot: botLabel },
        )}
      />
      <div className="flex w-full flex-col gap-3">
        <Button
          className="w-full"
          onClick={() => {
            window.location.assign(telegramHref);
          }}
        >
          <img src={telegramIconImg} alt="" className="h-4 w-4" />
          {t(($) => {
            return $.connectors.providerConnect.telegram.open;
          })}
        </Button>
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}

function AlreadyConnectedState({
  botUsername,
}: {
  botUsername: string | undefined;
}) {
  const { t } = useTranslation();
  const normalizedBotUsername = botUsername?.replace(/^@/, "");
  const telegramHref = normalizedBotUsername
    ? `tg://resolve?domain=${normalizedBotUsername}`
    : null;

  return (
    <PageShell>
      <TelegramMark state="success" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.alreadyTitle;
        })}
        body={
          normalizedBotUsername
            ? t(
                ($) => {
                  return $.connectors.providerConnect.telegram
                    .alreadyDescriptionNamed;
                },
                { bot: `@${normalizedBotUsername}` },
              )
            : t(($) => {
                return $.connectors.providerConnect.telegram.alreadyDescription;
              })
        }
      />
      <div className="flex w-full flex-col gap-3">
        {telegramHref ? (
          <Button
            className="w-full"
            onClick={() => {
              window.location.assign(telegramHref);
            }}
          >
            <img src={telegramIconImg} alt="" className="h-4 w-4" />
            {t(($) => {
              return $.connectors.providerConnect.telegram.open;
            })}
          </Button>
        ) : null}
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}

function ConnectActions({
  parsed,
  connecting,
  onConnect,
}: {
  parsed: TelegramConnectParams;
  connecting: boolean;
  onConnect: () => void;
}) {
  const { t } = useTranslation();
  if (parsed.connectSignature) {
    return (
      <div className="flex w-full flex-col gap-3">
        <ConnectSubmitButton connecting={connecting} onConnect={onConnect} />
      </div>
    );
  }

  return (
    <ConnectSubmitButton
      connecting={connecting}
      onConnect={onConnect}
      label={t(($) => {
        return $.connectors.providerConnect.telegram.continue;
      })}
    />
  );
}

type TelegramConnectParamErrorCode = Extract<
  ReturnType<typeof parseTelegramConnectParams>,
  { ok: false }
>["error"]["code"];

function InvalidTelegramConnectParams({
  code,
}: {
  code: TelegramConnectParamErrorCode;
}) {
  const { t } = useTranslation();
  const title =
    code === "incomplete"
      ? t(($) => {
          return $.connectors.providerConnect.telegram.linkIncompleteTitle;
        })
      : t(($) => {
          return $.connectors.providerConnect.telegram.invalidTitle;
        });
  const messages: Record<TelegramConnectParamErrorCode, string> = {
    incomplete: t(($) => {
      return $.connectors.providerConnect.telegram.linkIncomplete;
    }),
    invalid_signature: t(($) => {
      return $.connectors.providerConnect.telegram.invalidSignature;
    }),
    invalid_timestamp: t(($) => {
      return $.connectors.providerConnect.telegram.invalidTimestamp;
    }),
    invalid_user: t(($) => {
      return $.connectors.providerConnect.telegram.invalidUser;
    }),
    invalid_username: t(($) => {
      return $.connectors.providerConnect.telegram.invalidUsername;
    }),
  };
  return <InvalidState title={title} message={messages[code]} />;
}

function TelegramSessionLoadingState({ brandName }: { brandName: string }) {
  const { t } = useTranslation();
  return (
    <PageShell>
      <TelegramMark state="loading" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.common.checkingTitle;
        })}
        body={t(
          ($) => {
            return $.connectors.providerConnect.telegram.checkingSession;
          },
          { brandName },
        )}
      />
    </PageShell>
  );
}

function TelegramConnectionLoadingState() {
  const { t } = useTranslation();
  return (
    <PageShell>
      <TelegramMark state="loading" />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.checkingConnectionTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.telegram
            .checkingConnectionDescription;
        })}
      />
    </PageShell>
  );
}

export function TelegramConnectPage(): JSX.Element {
  const { t } = useTranslation();
  const brandName = useGet(brandName$);
  const params = useGet(searchParams$);
  const parsed = parseTelegramConnectParams(params);
  const clerkLoadable = useLoadable(clerk$);
  const linkStatusLoadable = useLastLoadable(telegramConnectLinkStatus$);
  const [connectLoadable, connectTelegram] = useLoadableSet(
    connectTelegramAccount$,
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
            return $.connectors.providerConnect.telegram.errorFallback;
          }),
        )
      : null;

  if (!parsed.ok) {
    return <InvalidTelegramConnectParams code={parsed.error.code} />;
  }

  if (clerkLoadable.state === "loading") {
    return <TelegramSessionLoadingState brandName={brandName} />;
  }

  if (clerkLoadable.state === "hasError") {
    return (
      <InvalidState
        title={t(($) => {
          return $.connectors.providerConnect.telegram.signInCheckFailed;
        })}
        message={t(($) => {
          return $.connectors.providerConnect.telegram.refresh;
        })}
      />
    );
  }

  if (!clerkLoadable.data.user) {
    return (
      <ConnectSignInState
        mark={<TelegramMark />}
        title={t(($) => {
          return $.connectors.providerConnect.telegram.signInTitle;
        })}
        description={t(
          ($) => {
            return $.connectors.providerConnect.telegram.signInDescription;
          },
          { brandName },
        )}
        button={t(
          ($) => {
            return $.connectors.providerConnect.telegram.signInButton;
          },
          { brandName },
        )}
      />
    );
  }

  if (success) {
    return <SuccessState botUsername={success.botUsername} />;
  }

  if (linkStatusLoadable.state === "loading") {
    return <TelegramConnectionLoadingState />;
  }

  const linkStatus =
    linkStatusLoadable.state === "hasData" ? linkStatusLoadable.data : null;
  if (linkStatus?.linked) {
    return <AlreadyConnectedState botUsername={linkStatus.botUsername} />;
  }
  if (
    !parsed.params.connectSignature &&
    linkStatus?.installation?.domainConfigured === false
  ) {
    return (
      <InvalidState
        title={t(($) => {
          return $.connectors.providerConnect.common.connectionFailed;
        })}
        message={t(($) => {
          return $.connectors.providerConnect.telegram.errorFallback;
        })}
      />
    );
  }

  return (
    <PageShell>
      <TelegramMark />
      <CenterText
        title={t(($) => {
          return $.connectors.providerConnect.telegram.connectTitle;
        })}
        body={t(($) => {
          return $.connectors.providerConnect.telegram.connectDescription;
        })}
      />
      <ConnectErrorAlert error={error} />
      <div className="flex w-full flex-col gap-4">
        <ConnectActions
          parsed={parsed.params}
          connecting={connecting}
          onConnect={() => {
            detach(connectTelegram(pageSignal), Reason.DomCallback);
          }}
        />
        <div className="flex justify-center">
          <BackLink />
        </div>
      </div>
    </PageShell>
  );
}
