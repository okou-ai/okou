import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Check, FileText } from "lucide-react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  surfaceVariants,
  cn,
} from "@okouai/ui";
import {
  sourcesFirstUi$,
  updateSourcesFirstDraft$,
  updateSourcesFirstUi$,
  type ChatChannelId,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import {
  OnboardingIllustration,
  ProductMark,
} from "./onboarding-step-parts.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";
import { useSourcesFirstFlow } from "./use-sources-first-flow.ts";

const SKILL_FILE_ACCEPT = ".md,text/markdown";
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
const SKILL_FILE_INPUT_ID = "onboarding-skill-file";

/** Confirms the chosen SKILL.md before it becomes a personal workflow. */
function SkillImportDialog() {
  const { t } = useTranslation();
  const ui = useGet(sourcesFirstUi$);
  const updateUi = useSet(updateSourcesFirstUi$);
  const updateDraft = useSet(updateSourcesFirstDraft$);

  return (
    <Dialog
      open={ui.pendingSkillName !== null}
      onOpenChange={(open) => {
        if (!open) {
          updateUi({ pendingSkillName: null });
        }
      }}
    >
      <DialogContent maxWidth="sm" contentClassName="p-6">
        <DialogTitle className="text-base font-semibold">
          {t(($) => {
            return $.onboarding.sourcesFirst.skills.previewTitle;
          })}
        </DialogTitle>
        <DialogDescription className="mt-1 text-sm text-muted-foreground">
          {t(($) => {
            return $.onboarding.sourcesFirst.skills.previewCopy;
          })}
        </DialogDescription>
        <p
          className={cn(
            surfaceVariants(),
            "mt-4 truncate p-3 text-sm text-foreground",
          )}
        >
          {ui.pendingSkillName}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              updateUi({ pendingSkillName: null });
            }}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.common.cancel;
            })}
          </Button>
          <Button
            type="button"
            onClick={() => {
              // Frontend pass: the SKILL.md upload becomes a personal workflow
              // once the import endpoint is wired.
              updateDraft({ importedWorkflowName: ui.pendingSkillName });
              updateUi({ pendingSkillName: null });
            }}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.confirm;
            })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The file the import produced, as the row a workflow list would show. */
function ImportedSkillRow({ name }: { readonly name: string }) {
  const { t } = useTranslation();

  return (
    <div className="flex w-full max-w-[420px] items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3 text-left">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground"
        aria-hidden="true"
      >
        <FileText size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {name}
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
 * The drop target and the imported workflow read as one column on the step's
 * own sheet, so importing a file only changes what the column says.
 */
function SkillDropCard({ imported }: { readonly imported: string | null }) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center gap-4 text-center">
      {imported ? (
        <>
          <ImportedSkillRow name={imported} />
          {/* A label opens the file picker without reaching for the DOM. */}
          <Button
            variant="ghost"
            size="sm"
            render={<label htmlFor={SKILL_FILE_INPUT_ID} />}
          >
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.replace;
            })}
          </Button>
        </>
      ) : (
        <>
          <OnboardingIllustration name="skill-import" alt="" size="poster" />
          <span>
            <span className="block text-sm font-medium text-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.skills.panelTitle;
              })}
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {t(($) => {
                return $.onboarding.sourcesFirst.skills.panelCopy;
              })}
            </span>
          </span>
          <Button render={<label htmlFor={SKILL_FILE_INPUT_ID} />}>
            {t(($) => {
              return $.onboarding.sourcesFirst.skills.import;
            })}
          </Button>
        </>
      )}
    </div>
  );
}

export function OnboardingSkillsPage() {
  const { t } = useTranslation();
  const flow = useSourcesFirstFlow("skills");
  const updateUi = useSet(updateSourcesFirstUi$);
  const imported = flow.draft.importedWorkflowName;

  return (
    <OnboardingStepLayout
      currentStep={flow.currentStep}
      totalSteps={flow.totalSteps}
      title={
        imported
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
      onPrimary={flow.goNext}
      primaryDisabled={imported === null}
      secondaryLabel={t(($) => {
        return $.onboarding.sourcesFirst.common.skip;
      })}
      onSecondary={flow.goNext}
      onBack={flow.goBack}
    >
      <SkillDropCard imported={imported} />
      <input
        id={SKILL_FILE_INPUT_ID}
        type="file"
        accept={SKILL_FILE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) {
            updateUi({ pendingSkillName: file.name.replace(/\.md$/u, "") });
          }
        }}
      />
      <SkillImportDialog />
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
  const channels = [
    {
      id: "telegram",
      mark: "telegram",
      label: t(($) => {
        return $.onboarding.sourcesFirst.slack.otherTelegram;
      }),
    },
    {
      id: "imessage",
      mark: "imessage",
      label: t(($) => {
        return $.onboarding.sourcesFirst.slack.otherImessage;
      }),
    },
    {
      id: "teams",
      mark: "teams",
      label: t(($) => {
        return $.onboarding.sourcesFirst.slack.otherTeams;
      }),
    },
  ] as const;

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.slack.othersLabel;
        })}
      </p>
      <div className="flex gap-2">
        {channels.map((channel) => {
          const added = picked.includes(channel.id);
          return (
            <Button
              key={channel.id}
              type="button"
              variant="outline"
              className="flex-1 gap-2"
              aria-pressed={added}
              onClick={() => {
                onPick(channel.id);
              }}
            >
              {added
                ? t(($) => {
                    return $.onboarding.sourcesFirst.slack.otherAdded;
                  })
                : channel.label}
              {added ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <ProductMark name={channel.mark} alt="" size="mark" />
              )}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export function OnboardingSlackPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
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
      onSecondary={flow.goNext}
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
            // Frontend pass, as with Slack above: each channel keeps its own
            // install once those integrations are wired.
            updateDraft({
              chatChannels: flow.draft.chatChannels.includes(channel)
                ? flow.draft.chatChannels.filter((picked) => {
                    return picked !== channel;
                  })
                : [...flow.draft.chatChannels, channel],
            });
          }}
        />
      </div>
    </OnboardingStepLayout>
  );
}
