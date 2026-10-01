import {
  useGet,
  useLoadable,
  useLastLoadable,
  useSet,
  type Loadable,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { Button, Card } from "@okouai/ui";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@okouai/api-contracts/contracts/integrations-telegram";
import {
  captureSourceOnboardingChannelClicked$,
  captureSourceOnboardingSlackInstallStarted$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import { agentPhoneLinkStatus$ } from "../../signals/okou-page/agentphone.ts";
import { slackOrgData$ } from "../../signals/okou-page/slack.ts";
import { teamsOrgData$ } from "../../signals/okou-page/teams.ts";
import { telegramBots$ } from "../../signals/okou-page/telegram.ts";
import { authorizeTelegramBot$ } from "../../signals/okou-page/telegram-authorization.ts";
import {
  onboardingPhoneCode$,
  requestOnboardingPhoneCode$,
} from "../../signals/onboarding/onboarding-chat-channels.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { openFreshOAuth } from "../../lib/oauth-window.ts";
import {
  AgentPhoneConnectionCodeContent,
  AgentPhoneConnectionCodeError,
  AgentPhoneConnectionCodeLoading,
} from "../okou-page/agentphone-connect-dialog.tsx";
import { ProductMark } from "./onboarding-step-parts.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

/** Install permission and account connection remain the provider's authority. */
type ChannelState =
  | { readonly kind: "pending" }
  | { readonly kind: "connected" }
  | { readonly kind: "install"; readonly url: string }
  | { readonly kind: "connect"; readonly url: string }
  | { readonly kind: "adminRequired" }
  | { readonly kind: "unavailable" };

interface ChannelStatus {
  readonly isConnected: boolean;
  readonly isInstalled: boolean | undefined;
  readonly isAdmin: boolean;
  readonly installUrl: string | null | undefined;
  readonly connectUrl: string | null | undefined;
}

function loadedChannelState<Status>(
  loadable: Loadable<Status>,
  read: (status: Awaited<Status>) => ChannelStatus,
): ChannelState {
  if (loadable.state !== "hasData") {
    return { kind: loadable.state === "hasError" ? "unavailable" : "pending" };
  }
  const status = read(loadable.data);
  if (status.isConnected) {
    return { kind: "connected" };
  }
  if (status.isInstalled) {
    return status.connectUrl
      ? { kind: "connect", url: status.connectUrl }
      : { kind: "unavailable" };
  }
  if (!status.isAdmin) {
    return { kind: "adminRequired" };
  }
  return status.installUrl
    ? { kind: "install", url: status.installUrl }
    : { kind: "unavailable" };
}

function ChannelNote({
  state,
  channel,
}: {
  readonly state: ChannelState;
  readonly channel: string;
}) {
  const { t } = useTranslation();
  if (state.kind !== "adminRequired" && state.kind !== "unavailable") {
    return null;
  }
  return (
    <p className="text-xs leading-5 text-muted-foreground">
      {state.kind === "adminRequired"
        ? t(
            ($) => {
              return $.onboarding.sourcesFirst.slack.channelAdminRequired;
            },
            {
              channel,
            },
          )
        : t(
            ($) => {
              return $.onboarding.sourcesFirst.slack.channelUnavailable;
            },
            {
              channel,
            },
          )}
    </p>
  );
}

function ChannelButtonContent({
  channel,
  connected,
}: {
  readonly channel: "slack" | "telegram" | "teams";
  readonly connected: boolean;
}) {
  const { t } = useTranslation();
  const label =
    channel === "slack"
      ? t(($) => {
          return $.onboarding.sourcesFirst.slack.name;
        })
      : channel === "telegram"
        ? t(($) => {
            return $.onboarding.sourcesFirst.slack.otherTelegram;
          })
        : t(($) => {
            return $.onboarding.sourcesFirst.slack.otherTeams;
          });
  return (
    <>
      <ProductMark name={channel} alt="" size="mark" />
      {label}
      {connected && (
        <>
          <span className="sr-only">
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.otherAdded;
            })}
          </span>
          <Check size={16} aria-hidden="true" />
        </>
      )}
    </>
  );
}

function InstalledChannelButton({
  channel,
  state,
}: {
  readonly channel: "slack" | "teams";
  readonly state: ChannelState;
}) {
  const { t } = useTranslation();
  const captureInstallStarted = useSet(
    captureSourceOnboardingSlackInstallStarted$,
  );
  const captureChannelClicked = useSet(captureSourceOnboardingChannelClicked$);
  const actionUrl =
    state.kind === "install" || state.kind === "connect" ? state.url : null;
  const connected = state.kind === "connected";
  return (
    <Button
      type="button"
      variant="outline"
      className="min-w-0 flex-1 gap-2 px-3"
      aria-pressed={connected}
      aria-label={
        channel === "slack"
          ? connected
            ? t(($) => {
                return $.onboarding.sourcesFirst.slack.connectedStatus;
              })
            : state.kind === "connect"
              ? t(($) => {
                  return $.onboarding.sourcesFirst.slack.connectAction;
                })
              : t(($) => {
                  return $.onboarding.sourcesFirst.slack.add;
                })
          : undefined
      }
      disabled={actionUrl === null}
      onClick={() => {
        if (actionUrl) {
          if (channel === "slack") {
            captureInstallStarted();
          } else {
            captureChannelClicked("teams", true);
          }
          openFreshOAuth(actionUrl);
        }
      }}
    >
      <ChannelButtonContent channel={channel} connected={connected} />
    </Button>
  );
}

function TelegramButton({ connected }: { readonly connected: boolean }) {
  const captureChannelClicked = useSet(captureSourceOnboardingChannelClicked$);
  const pageSignal = useGet(pageSignal$);
  const [connection, connect] = useLoadableSet(authorizeTelegramBot$);
  return (
    <Button
      type="button"
      variant="outline"
      className="min-w-0 flex-1 gap-2 px-3"
      aria-pressed={connected}
      disabled={connected || connection.state === "loading"}
      onClick={() => {
        captureChannelClicked("telegram", true);
        detach(
          connect(OFFICIAL_TELEGRAM_BOT_ID, pageSignal),
          Reason.DomCallback,
        );
      }}
    >
      <ChannelButtonContent channel="telegram" connected={connected} />
    </Button>
  );
}

function InlineImessageConnection() {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(agentPhoneLinkStatus$);
  const codeLoadable = useLoadable(onboardingPhoneCode$);
  const code = codeLoadable.state === "hasData" ? codeLoadable.data : null;
  const requestCode = useSet(requestOnboardingPhoneCode$);
  const captureChannelClicked = useSet(captureSourceOnboardingChannelClicked$);
  const pageSignal = useGet(pageSignal$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const onRetry = () => {
    detach(requestCode(pageSignal), Reason.DomCallback);
  };
  return (
    <Card className="rounded-xl border border-border bg-background p-6 max-sm:p-5">
      <div className="mb-2 flex items-center gap-3">
        <ProductMark name="imessage" alt="" />
        <h2 className="text-xl font-semibold tracking-tight">
          {t(($) => {
            return $.onboarding.sourcesFirst.chatChannels.imessageTitle;
          })}
        </h2>
      </div>
      <p className="mb-5 text-sm text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.chatChannels.imessageCopy;
        })}
      </p>
      {status?.linked ? (
        <p className="flex items-center gap-2 text-sm" role="status">
          <Check size={16} aria-hidden="true" />
          {t(($) => {
            return $.onboarding.sourcesFirst.chatChannels.imessageConnected;
          })}
        </p>
      ) : code?.kind === "ready" && status?.agentPhoneNumber ? (
        <>
          <p className="mb-3 text-sm text-muted-foreground max-sm:hidden pointer-coarse:hidden">
            {t(($) => {
              return $.onboarding.sourcesFirst.chatChannels.imessageScan;
            })}
          </p>
          <AgentPhoneConnectionCodeContent
            phoneNumber={status.agentPhoneNumber}
            connectionCode={code.code}
            inline
            onOpenMessages={() => {
              captureChannelClicked("imessage", true);
            }}
          />
        </>
      ) : code?.kind === "expired" ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3">
          <p className="text-sm text-muted-foreground" role="status">
            {t(($) => {
              return $.onboarding.sourcesFirst.chatChannels.imessageExpired;
            })}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            {t(($) => {
              return $.onboarding.sourcesFirst.chatChannels.imessageRefresh;
            })}
          </Button>
        </div>
      ) : codeLoadable.state === "hasError" ? (
        <AgentPhoneConnectionCodeError onRetry={onRetry} />
      ) : code?.kind === "unavailable" ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t(
            ($) => {
              return $.onboarding.sourcesFirst.slack.channelUnavailable;
            },
            {
              channel: t(($) => {
                return $.onboarding.sourcesFirst.slack.otherImessage;
              }),
            },
          )}
        </p>
      ) : (
        <AgentPhoneConnectionCodeLoading />
      )}
    </Card>
  );
}

export function OnboardingSlackPage() {
  const { t } = useTranslation();
  const flow = useSourcesFirstFlow("slack");
  const slack = loadedChannelState(useLastLoadable(slackOrgData$), (status) => {
    return {
      isConnected: status.isConnected,
      isInstalled: status.isInstalled,
      isAdmin: status.isAdmin,
      installUrl: status.installUrl,
      connectUrl: status.connectUrl,
    };
  });
  const teams = loadedChannelState(useLastLoadable(teamsOrgData$), (status) => {
    return {
      isConnected: status.isConnected,
      isInstalled: status.isInstalled,
      isAdmin: status.isAdmin,
      installUrl: status.connectUrl ?? status.installUrl,
      connectUrl: status.connectUrl,
    };
  });
  const phone = useLastLoadable(agentPhoneLinkStatus$);
  const bots = useLastLoadable(telegramBots$);
  const telegramConnected =
    bots.state === "hasData" &&
    bots.data.some((bot) => {
      return bot.id === OFFICIAL_TELEGRAM_BOT_ID && bot.isConnected;
    });
  const connected =
    slack.kind === "connected" ||
    teams.kind === "connected" ||
    (phone.state === "hasData" && phone.data.linked) ||
    telegramConnected;
  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={
        connected
          ? t(($) => {
              return $.onboarding.sourcesFirst.chatChannels.connectedTitle;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.chatChannels.title;
            })
      }
      description={t(($) => {
        return $.onboarding.sourcesFirst.chatChannels.copy;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      onPrimary={flow.goNext}
      primaryDisabled={!connected}
      secondaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.notNow;
      })}
      onSecondary={flow.goSkip}
      onBack={flow.goBack}
    >
      <div className="mx-auto flex w-full max-w-[600px] flex-col gap-5">
        <InlineImessageConnection />
        <div>
          <p className="mb-2 text-xs text-muted-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.chatChannels.othersLabel;
            })}
          </p>
          <div className="flex gap-2">
            <InstalledChannelButton channel="slack" state={slack} />
            <TelegramButton connected={telegramConnected} />
            <InstalledChannelButton channel="teams" state={teams} />
          </div>
          <div className="mt-2 space-y-1">
            <ChannelNote
              state={slack}
              channel={t(($) => {
                return $.onboarding.sourcesFirst.slack.name;
              })}
            />
            <ChannelNote
              state={teams}
              channel={t(($) => {
                return $.onboarding.sourcesFirst.slack.otherTeams;
              })}
            />
          </div>
        </div>
      </div>
    </OnboardingStepLayout>
  );
}
