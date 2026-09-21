import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Check, Copy, FileText, Loader2 } from "lucide-react";
import { Button, cn } from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import type { WorkflowSummary } from "@okouai/api-contracts/contracts/workflows";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  captureSourceOnboardingChannelClicked$,
  captureSourceOnboardingSlackInstallStarted$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  agentPhoneLinkStatus$,
  createAgentPhoneLinkCode$,
  setAgentPhoneConnectDialogOpen$,
} from "../../signals/okou-page/agentphone.ts";
import { AgentPhoneConnectDialog } from "../okou-page/agentphone-connect-dialog.tsx";
import {
  copySkillImportPrompt$,
  enterSkillImport$,
  sourcesFirstSkillImport$,
  type SkillImportState,
} from "../../signals/onboarding/onboarding-skill-import.ts";
import {
  updateSourcesFirstDraft$,
  type ChatChannelId,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  OnboardingIllustration,
  ProductMark,
} from "./onboarding-step-parts.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

/* The scene's faces: Okou's own avatar, and a photo for each teammate. */
const OKOU_AVATAR_URL = platformStaticAssetUrl(
  "views/onboarding/assets/okou-avatar-2df72642115f.webp",
);
const SLACK_SCENE_AVATARS = {
  context: platformStaticAssetUrl(
    "views/onboarding/assets/slack-scene-dan-e0fc67b12a69.jpg",
  ),
  ask: platformStaticAssetUrl(
    "views/onboarding/assets/slack-scene-mia-379d5c026871.jpg",
  ),
} as const;

/** The prompt itself: long, read in full, and selectable where it stands. */
function SkillImportPromptBody({ prompt }: { readonly prompt: string }) {
  const { t } = useTranslation();

  return (
    <pre
      tabIndex={0}
      aria-label={t(($) => {
        return $.onboarding.sourcesFirst.skills.promptLabel;
      })}
      className="max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border/60 bg-muted/30 p-4 font-mono text-xs leading-5 text-muted-foreground"
    >
      {prompt}
    </pre>
  );
}

/** The session is still opening: the step says so where the prompt will be. */
function SkillImportPromptPending() {
  const { t } = useTranslation();

  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/30 p-4 text-sm text-muted-foreground"
    >
      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
      {t(($) => {
        return $.onboarding.sourcesFirst.skills.preparing;
      })}
    </p>
  );
}

/**
 * The session could not be opened. The step offers it again and stays out of
 * the way otherwise: Continue and Skip never waited on it.
 */
function SkillImportPromptFailed() {
  const { t } = useTranslation();
  const retry = useSet(enterSkillImport$);
  const pageSignal = useGet(pageSignal$);

  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-border/60 bg-muted/30 p-4">
      <p role="alert" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.startError;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          detach(retry(pageSignal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.tryAgain;
        })}
      </Button>
    </div>
  );
}

/** Copies the prompt, and says whether the clipboard took it. */
function SkillImportCopyButton({ copied }: { readonly copied: boolean }) {
  const { t } = useTranslation();
  const copyPrompt = useSet(copySkillImportPrompt$);
  const pageSignal = useGet(pageSignal$);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="shrink-0 gap-1.5"
      onClick={() => {
        detach(
          (async () => {
            if (await copyPrompt(pageSignal)) {
              return;
            }
            toast.error(
              t(($) => {
                return $.onboarding.sourcesFirst.skills.copyError;
              }),
            );
          })(),
          Reason.DomCallback,
        );
      }}
    >
      {copied ? (
        <Check size={14} aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
      {copied
        ? t(($) => {
            return $.onboarding.sourcesFirst.skills.copied;
          })
        : t(($) => {
            return $.onboarding.sourcesFirst.skills.copyPrompt;
          })}
    </Button>
  );
}

/** One skill the import wrote, as the row the workflow list would show. */
function ImportedSkillRow({ skill }: { readonly skill: WorkflowSummary }) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-left">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground"
        aria-hidden="true"
      >
        <FileText size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {skill.displayName ?? skill.name}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.skills.importedCopy;
          })}
        </span>
      </span>
      <Check size={16} className="shrink-0 text-emerald-600" />
    </div>
  );
}

/**
 * What the import has produced so far. The list is polled, so a skill appears
 * here on its own; until one does, the step says what it is waiting for.
 */
function ImportedSkillList({
  skills,
}: {
  readonly skills: readonly WorkflowSummary[];
}) {
  const { t } = useTranslation();

  return (
    <div>
      <p className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.skills.importedLabel;
        })}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {skills.length === 0 ? (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/70 px-4 py-3">
            <OnboardingIllustration name="skill-import" alt="" />
            <span className="text-sm text-muted-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.skills.waiting;
              })}
            </span>
          </div>
        ) : (
          skills.map((skill) => {
            return <ImportedSkillRow key={skill.id} skill={skill} />;
          })
        )}
      </div>
    </div>
  );
}

function SkillImportPanel({ state }: { readonly state: SkillImportState }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.promptTitle;
            })}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.promptCopy;
            })}
          </p>
        </div>
        {state.prompt === null ? null : (
          <SkillImportCopyButton copied={state.copied} />
        )}
      </div>
      {state.prompt === null ? (
        state.status === "failed" ? (
          <SkillImportPromptFailed />
        ) : (
          <SkillImportPromptPending />
        )
      ) : (
        <SkillImportPromptBody prompt={state.prompt} />
      )}
    </div>
  );
}

export function OnboardingSkillsPage() {
  const { t } = useTranslation();
  const flow = useSourcesFirstFlow("skills");
  const skillImport = useGet(sourcesFirstSkillImport$);

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={
        skillImport.imported.length > 0
          ? t(($) => {
              return $.onboarding.sourcesFirst.skills.importedTitle;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.skills.title;
            })
      }
      description={t(($) => {
        return $.onboarding.sourcesFirst.skills.copy;
      })}
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.continue;
      })}
      // Nothing on this step is required: a run that imports no skill at all
      // leaves it the same way as one that imports ten.
      onPrimary={flow.goNext}
      secondaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.skip;
      })}
      onSecondary={flow.goSkip}
      onBack={flow.goBack}
    >
      <div className="mx-auto flex w-full max-w-[600px] flex-col gap-6">
        <SkillImportPanel state={skillImport} />
        <ImportedSkillList skills={skillImport.imported} />
      </div>
    </OnboardingStepLayout>
  );
}

/** A teammate's mark: Slack draws a rounded square, not a circle. */
function SlackAvatar({ src }: { readonly src: string }) {
  return (
    <img
      src={src}
      alt=""
      className="size-7 shrink-0 rounded-[4px] object-cover"
    />
  );
}

/** One message in the channel: the author's mark, then what they said. */
function SlackMessage({
  avatar,
  author,
  badge,
  time,
  children,
}: {
  readonly avatar: ReactNode;
  readonly author: string;
  readonly badge?: string;
  readonly time: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex gap-2">
      {avatar}
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1.5">
          <span className="text-[13px] font-bold text-[#1D1C1D]">{author}</span>
          {badge ? (
            <span className="rounded-[3px] bg-[#E8E8E8] px-1 text-[10px] font-bold uppercase leading-4 text-[#616061]">
              {badge}
            </span>
          ) : null}
          <span className="text-[11px] text-[#616061]">{time}</span>
        </p>
        <div className="mt-0.5 text-[13px] leading-[19px] text-[#1D1C1D]">
          {children}
        </div>
      </div>
    </div>
  );
}

/** A channel in the rail, the current one lit the way Slack lights it. */
function SlackChannel({
  name,
  current = false,
}: {
  readonly name: string;
  readonly current?: boolean;
}) {
  return (
    <p
      className={cn(
        "truncate rounded px-2 py-[3px] text-[13px] text-[#ffffff]/70",
        current && "bg-[#1164A3] font-bold text-[#ffffff]",
      )}
    >
      {name}
    </p>
  );
}

/** The workspace rail, where Okou also sits as an app. */
function SlackRail({
  channel,
  okouAuthor,
  appBadge,
}: {
  readonly channel: string;
  readonly okouAuthor: string;
  readonly appBadge: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="hidden w-[148px] shrink-0 flex-col bg-[#3F0E40] px-2 py-3 sm:flex">
      <p className="px-2 pb-3 text-[13px] font-bold text-[#ffffff]">
        {t(($) => {
          return $.onboarding.sourcesFirst.slack.previewWorkspace;
        })}
      </p>
      <p className="px-2 pb-1 text-[11px] text-[#ffffff]/60">
        {t(($) => {
          return $.onboarding.sourcesFirst.slack.previewChannelsLabel;
        })}
      </p>
      <SlackChannel
        name={t(($) => {
          return $.onboarding.sourcesFirst.slack.previewChannelGeneral;
        })}
      />
      <SlackChannel name={channel} current />
      <SlackChannel
        name={t(($) => {
          return $.onboarding.sourcesFirst.slack.previewChannelLaunch;
        })}
      />
      <p className="px-2 pb-1 pt-3 text-[11px] text-[#ffffff]/60">
        {t(($) => {
          return $.onboarding.sourcesFirst.slack.previewDirectMessagesLabel;
        })}
      </p>
      <p className="flex items-center gap-1.5 px-2 py-[3px] text-[13px] text-[#ffffff]/70">
        <img
          src={OKOU_AVATAR_URL}
          alt=""
          className="size-4 shrink-0 rounded-[3px] object-cover"
        />
        <span className="truncate">{okouAuthor}</span>
        <span className="rounded-[3px] bg-[#ffffff]/15 px-1 text-[9px] font-bold uppercase leading-4 text-[#ffffff]/70">
          {appBadge}
        </span>
      </p>
    </div>
  );
}

/** The channel: the ask that mentions Okou, and the answer it gets. */
function SlackChannelPane({
  channel,
  okouAuthor,
  appBadge,
}: {
  readonly channel: string;
  readonly okouAuthor: string;
  readonly appBadge: string;
}) {
  const { t } = useTranslation();
  const contextAuthor = t(($) => {
    return $.onboarding.sourcesFirst.slack.previewContextAuthor;
  });
  const askAuthor = t(($) => {
    return $.onboarding.sourcesFirst.slack.previewAskAuthor;
  });

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-baseline gap-2 border-b border-[#1D1C1D]/10 px-4 py-2.5">
        <span className="shrink-0 text-[14px] font-bold text-[#1D1C1D]">
          {channel}
        </span>
        <span className="truncate text-[12px] text-[#616061]">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewChannelTopic;
          })}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        <SlackMessage
          avatar={<SlackAvatar src={SLACK_SCENE_AVATARS.context} />}
          author={contextAuthor}
          time={t(($) => {
            return $.onboarding.sourcesFirst.slack.previewContextTime;
          })}
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewContext;
          })}
        </SlackMessage>
        <SlackMessage
          avatar={<SlackAvatar src={SLACK_SCENE_AVATARS.ask} />}
          author={askAuthor}
          time={t(($) => {
            return $.onboarding.sourcesFirst.slack.previewTime;
          })}
        >
          <span className="rounded-[3px] bg-[#E8F5FA] px-1 font-medium text-[#1264A3]">
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.previewMention;
            })}
          </span>{" "}
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewAsk;
          })}
          <span className="mt-1 block text-[12px] font-bold text-[#1264A3]">
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.previewReplies;
            })}
          </span>
        </SlackMessage>
        <SlackMessage
          avatar={
            <img
              src={OKOU_AVATAR_URL}
              alt=""
              className="size-7 shrink-0 rounded-[4px] object-cover"
            />
          }
          author={okouAuthor}
          badge={appBadge}
          time={t(($) => {
            return $.onboarding.sourcesFirst.slack.previewReplyTime;
          })}
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewReply;
          })}
        </SlackMessage>
      </div>
      {/* The composer: the line the next ask would be typed on. */}
      <div className="px-4 pb-3">
        <p className="rounded-lg border border-[#1D1C1D]/20 px-3 py-2 text-[13px] text-[#8D8D8D]">
          {t(($) => {
            return $.onboarding.sourcesFirst.slack.previewComposer;
          })}
        </p>
      </div>
    </div>
  );
}

/**
 * What the step is actually offering, drawn as the workspace it happens in.
 * The scene keeps Slack's own colours literally, so it reads as Slack in
 * either theme.
 */
function SlackPreview() {
  const { t } = useTranslation();
  const okouAuthor = t(($) => {
    return $.onboarding.sourcesFirst.slack.previewReplyAuthor;
  });
  const appBadge = t(($) => {
    return $.onboarding.sourcesFirst.slack.previewAppBadge;
  });
  const channel = t(($) => {
    return $.onboarding.sourcesFirst.slack.previewChannel;
  });

  return (
    <div className="overflow-hidden rounded-xl border border-[#1D1C1D]/15 bg-[#ffffff] shadow-surface">
      <div className="flex">
        <SlackRail
          channel={channel}
          okouAuthor={okouAuthor}
          appBadge={appBadge}
        />
        <SlackChannelPane
          channel={channel}
          okouAuthor={okouAuthor}
          appBadge={appBadge}
        />
      </div>
    </div>
  );
}

/**
 * A chat channel offered beside Slack, as the button that adds it: the name
 * stays whatever the state, so a button reading only "Added" never stops
 * saying which channel was added.
 */
function ChatChannelButton({
  label,
  mark,
  added,
  disabled = false,
  onClick,
}: {
  readonly label: string;
  readonly mark: Parameters<typeof ProductMark>[0]["name"];
  readonly added: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Button
      type="button"
      variant="outline"
      className="flex-1 gap-2"
      aria-pressed={added}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
      {added ? (
        <>
          <span className="sr-only">
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.otherAdded;
            })}
          </span>
          <Check size={16} aria-hidden="true" />
        </>
      ) : (
        <ProductMark name={mark} alt="" size="mark" />
      )}
    </Button>
  );
}

/**
 * iMessage is AgentPhone: the tile opens the same link this workspace uses
 * everywhere else, and what it reports is the link's own status rather than
 * anything this step remembers. It is behind the switch the Works entry uses,
 * so it is absent where that entry is.
 */
function AgentPhoneChannelButton() {
  const { t } = useTranslation();
  const statusLoadable = useLastLoadable(agentPhoneLinkStatus$);
  const [connectionCodeLoadable, createConnectionCode] = useLoadableSet(
    createAgentPhoneLinkCode$,
  );
  const setConnectOpen = useSet(setAgentPhoneConnectDialogOpen$);
  const captureChannelClicked = useSet(captureSourceOnboardingChannelClicked$);
  const pageSignal = useGet(pageSignal$);
  const status =
    statusLoadable.state === "hasData" ? statusLoadable.data : null;
  const agentPhoneNumber = status?.agentPhoneNumber ?? null;
  const connectionCode =
    connectionCodeLoadable.state === "hasData"
      ? connectionCodeLoadable.data
      : null;
  const requestConnectionCode = () => {
    detach(createConnectionCode(pageSignal), Reason.DomCallback);
  };

  return (
    <>
      <ChatChannelButton
        label={t(($) => {
          return $.onboarding.sourcesFirst.slack.otherImessage;
        })}
        mark="imessage"
        added={status?.linked ?? false}
        // Until the link status is read there is nothing to connect to, and a
        // workspace without a number has no message to send.
        disabled={agentPhoneNumber === null || (status?.linked ?? false)}
        onClick={() => {
          captureChannelClicked("imessage", true);
          requestConnectionCode();
          setConnectOpen(true);
        }}
      />
      <AgentPhoneConnectDialog
        phoneNumber={agentPhoneNumber}
        connectionCode={connectionCode}
        connectionCodeFailed={connectionCodeLoadable.state === "hasError"}
        onRetry={requestConnectionCode}
      />
    </>
  );
}

/**
 * The same mention works in Telegram, iMessage and Teams. They sit under
 * Slack's own button, each with its mark beside the name.
 */
function OtherChatChannels({
  picked,
  onPick,
}: {
  readonly picked: readonly ChatChannelId[];
  readonly onPick: (channel: ChatChannelId) => void;
}) {
  const { t } = useTranslation();
  const agentPhoneEnabled =
    useGet(featureSwitch$)[FeatureSwitchKey.AgentPhoneEntry] ?? false;

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.slack.othersLabel;
        })}
      </p>
      <div className="flex gap-2">
        <ChatChannelButton
          label={t(($) => {
            return $.onboarding.sourcesFirst.slack.otherTelegram;
          })}
          mark="telegram"
          added={picked.includes("telegram")}
          onClick={() => {
            onPick("telegram");
          }}
        />
        {agentPhoneEnabled ? <AgentPhoneChannelButton /> : null}
        <ChatChannelButton
          label={t(($) => {
            return $.onboarding.sourcesFirst.slack.otherTeams;
          })}
          mark="teams"
          added={picked.includes("teams")}
          onClick={() => {
            onPick("teams");
          }}
        />
      </div>
    </div>
  );
}

export function OnboardingSlackPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
  const captureInstallStarted = useSet(
    captureSourceOnboardingSlackInstallStarted$,
  );
  const captureChannelClicked = useSet(captureSourceOnboardingChannelClicked$);
  const flow = useSourcesFirstFlow("slack");
  const connected = flow.draft.slackStatus === "connected";

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={
        connected
          ? t(($) => {
              return $.onboarding.sourcesFirst.slack.connectedTitle;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.slack.title;
            })
      }
      description={
        connected
          ? t(($) => {
              return $.onboarding.sourcesFirst.slack.connectedCopy;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.slack.copy;
            })
      }
      primaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.finish;
      })}
      onPrimary={flow.goNext}
      secondaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.skip;
      })}
      onSecondary={flow.goSkip}
      onBack={flow.goBack}
    >
      {/* One column on the step's own sheet: what it looks like in a channel,
          then the one way to add it. */}
      <div className="mx-auto flex w-full max-w-[600px] flex-col gap-5">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.rowTitle;
            })}
          </p>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
            {t(($) => {
              return $.onboarding.sourcesFirst.slack.rowCopy;
            })}
          </p>
        </div>
        <SlackPreview />
        <Button
          type="button"
          variant={connected ? "outline" : "neutral"}
          disabled={connected}
          className="w-full gap-2"
          onClick={() => {
            captureInstallStarted();
            // Frontend pass: the Slack install round trip replaces this once
            // the integration step is wired.
            updateDraft({ slackStatus: "connected" });
          }}
        >
          {connected ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <ProductMark name="slack" alt="" />
          )}
          {connected
            ? t(($) => {
                return $.onboarding.sourcesFirst.slack.connectedStatus;
              })
            : t(($) => {
                return $.onboarding.sourcesFirst.slack.add;
              })}
        </Button>
        <OtherChatChannels
          picked={flow.draft.chatChannels}
          onPick={(channel) => {
            const added = !flow.draft.chatChannels.includes(channel);
            captureChannelClicked(channel, added);
            // Frontend pass, as with Slack above: each channel keeps its own
            // install once those integrations are wired.
            updateDraft({
              chatChannels: added
                ? [...flow.draft.chatChannels, channel]
                : flow.draft.chatChannels.filter((picked) => {
                    return picked !== channel;
                  }),
            });
          }}
        />
      </div>
    </OnboardingStepLayout>
  );
}
