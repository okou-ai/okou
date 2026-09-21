import type { ComponentProps, ReactNode } from "react";
import { useGet, useLastLoadable, useSet, type Loadable } from "ccstate-react";
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
  captureSourceOnboardingChannelClicked$,
  captureSourceOnboardingSlackInstallStarted$,
} from "../../signals/bootstrap/source-onboarding-telemetry.ts";
import {
  sourcesFirstUi$,
  updateSourcesFirstDraft$,
  updateSourcesFirstUi$,
  type ChatChannelId,
} from "../../signals/onboarding/onboarding-sources-first-state.ts";
import { slackOrgData$ } from "../../signals/okou-page/slack.ts";
import { teamsOrgData$ } from "../../signals/okou-page/teams.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  OnboardingIllustration,
  ProductMark,
} from "./onboarding-step-parts.tsx";
import { OnboardingStepLayout } from "./onboarding-step-layout.tsx";
import { openFreshOAuth } from "../../lib/oauth-window.ts";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";
import { Link } from "../router/link.tsx";
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
          {/* A label opens the file picker without reaching for the DOM, so
              the control is not the native button Base UI expects. */}
          <Button
            variant="ghost"
            size="sm"
            nativeButton={false}
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
          <Button
            nativeButton={false}
            render={<label htmlFor={SKILL_FILE_INPUT_ID} />}
          >
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
      onSecondary={flow.goSkip}
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
 * What a chat channel offers right now. The install itself happens in the
 * provider's own tab, so the step reads the org's installation rather than
 * remembering the click that started it.
 */
type ChannelState =
  | { readonly kind: "pending" }
  | { readonly kind: "connected" }
  | { readonly kind: "install"; readonly url: string }
  | { readonly kind: "connect"; readonly url: string }
  | { readonly kind: "adminRequired" }
  | { readonly kind: "unavailable" };

interface ChannelStatus {
  readonly isConnected: boolean;
  /** Undefined where the status leaves the workspace-wide install unstated. */
  readonly isInstalled: boolean | undefined;
  readonly isAdmin: boolean;
  /** Where an admin adds the app to the whole workspace. */
  readonly installUrl: string | null | undefined;
  /** Where one person links their own account to an existing install. */
  readonly connectUrl: string | null | undefined;
}

function channelState(status: ChannelStatus): ChannelState {
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

/**
 * A status the step cannot read offers nothing, which the step says rather
 * than leaving a button that does nothing.
 */
function loadedChannelState<Status>(
  loadable: Loadable<Status>,
  read: (status: Awaited<Status>) => ChannelStatus,
): ChannelState {
  if (loadable.state === "hasData") {
    return channelState(read(loadable.data));
  }
  return loadable.state === "hasError"
    ? { kind: "unavailable" }
    : { kind: "pending" };
}

function channelActionUrl(state: ChannelState): string | null {
  return state.kind === "install" || state.kind === "connect"
    ? state.url
    : null;
}

/**
 * Why a channel has nothing to offer, named rather than left as a control that
 * does nothing: someone else has to add it, or there is nothing here to add.
 */
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
            { channel },
          )
        : t(
            ($) => {
              return $.onboarding.sourcesFirst.slack.channelUnavailable;
            },
            { channel },
          )}
    </p>
  );
}

/**
 * Slack's own button: the one way the step is meant to be answered. It adds
 * the app to the workspace, or links the account once the app is already in.
 */
function SlackChannelButton({ state }: { readonly state: ChannelState }) {
  const { t } = useTranslation();
  const captureInstallStarted = useSet(
    captureSourceOnboardingSlackInstallStarted$,
  );
  const connected = state.kind === "connected";
  const actionUrl = channelActionUrl(state);

  return (
    <Button
      type="button"
      variant={connected ? "outline" : "neutral"}
      disabled={actionUrl === null}
      className="w-full gap-2"
      onClick={() => {
        if (actionUrl) {
          captureInstallStarted();
          openFreshOAuth(actionUrl);
        }
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
        : state.kind === "connect"
          ? t(($) => {
              return $.onboarding.sourcesFirst.slack.connectAction;
            })
          : t(($) => {
              return $.onboarding.sourcesFirst.slack.add;
            })}
    </Button>
  );
}

const CHAT_CHANNEL_TILE_CLASS = "flex-1 gap-2";

/** What a tile in the row under Slack reads: the channel, then its state. */
function ChatChannelTileContent({
  label,
  mark,
  added,
}: {
  readonly label: string;
  readonly mark: ComponentProps<typeof ProductMark>["name"];
  readonly added: boolean;
}) {
  const { t } = useTranslation();

  return (
    <>
      {/* The name stays whatever the state: a tile reading only "Added" no
          longer says which channel was added. */}
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
    </>
  );
}

/** A tile that acts here: it toggles an answer, or opens an install. */
function ChatChannelTile({
  label,
  mark,
  added,
  ...props
}: {
  readonly label: string;
  readonly mark: ComponentProps<typeof ProductMark>["name"];
  readonly added: boolean;
} & Pick<
  ComponentProps<typeof Button>,
  "aria-pressed" | "disabled" | "onClick"
>) {
  return (
    <Button
      type="button"
      variant="outline"
      className={CHAT_CHANNEL_TILE_CLASS}
      {...props}
    >
      <ChatChannelTileContent label={label} mark={mark} added={added} />
    </Button>
  );
}

/**
 * Telegram's setup asks for a bot token and which agent answers it, which is
 * more than a tile can hold, so this one hands over to the settings page that
 * already asks. It navigates in-app, so the answers given so far are still
 * here when the browser comes back to the step.
 */
function TelegramTile({ onOpen }: { readonly onOpen: () => void }) {
  const { t } = useTranslation();

  return (
    <Button asChild variant="outline" className={CHAT_CHANNEL_TILE_CLASS}>
      <Link pathname={ROUTES.settingsTelegram} onClick={onOpen}>
        <ChatChannelTileContent
          label={t(($) => {
            return $.onboarding.sourcesFirst.slack.otherTelegram;
          })}
          mark="telegram"
          added={false}
        />
      </Link>
    </Button>
  );
}

/**
 * The same mention works in Telegram, iMessage and Teams. They sit under
 * Slack's own button, each with its mark beside the name, and Teams installs
 * the way Slack does.
 */
function OtherChatChannels({
  picked,
  onPick,
}: {
  readonly picked: readonly ChatChannelId[];
  readonly onPick: (channel: ChatChannelId) => void;
}) {
  const { t } = useTranslation();
  const captureChannelClicked = useSet(captureSourceOnboardingChannelClicked$);
  const teams = loadedChannelState(useLastLoadable(teamsOrgData$), (status) => {
    return {
      isConnected: status.isConnected,
      isInstalled: status.isInstalled,
      isAdmin: status.isAdmin,
      // Teams' own OAuth adds the app while it connects the account, so the
      // connect URL is also how an admin installs it.
      installUrl: status.connectUrl ?? status.installUrl,
      connectUrl: status.connectUrl,
    };
  });
  const teamsName = t(($) => {
    return $.onboarding.sourcesFirst.slack.otherTeams;
  });
  const teamsUrl = channelActionUrl(teams);

  return (
    <div>
      <p className="mb-2 text-xs text-muted-foreground">
        {t(($) => {
          return $.onboarding.sourcesFirst.slack.othersLabel;
        })}
      </p>
      <div className="flex gap-2">
        {/* A tile that leaves for an install is only ever a click to add it,
            so the funnel reads that click as one. */}
        <TelegramTile
          onOpen={() => {
            captureChannelClicked("telegram", true);
          }}
        />
        <ChatChannelTile
          label={t(($) => {
            return $.onboarding.sourcesFirst.slack.otherImessage;
          })}
          mark="imessage"
          added={picked.includes("imessage")}
          aria-pressed={picked.includes("imessage")}
          onClick={() => {
            captureChannelClicked("imessage", !picked.includes("imessage"));
            onPick("imessage");
          }}
        />
        <ChatChannelTile
          label={teamsName}
          mark="teams"
          added={teams.kind === "connected"}
          disabled={teamsUrl === null}
          onClick={() => {
            if (teamsUrl) {
              captureChannelClicked("teams", true);
              openFreshOAuth(teamsUrl);
            }
          }}
        />
      </div>
      <ChannelNote state={teams} channel={teamsName} />
    </div>
  );
}

export function OnboardingSlackPage() {
  const { t } = useTranslation();
  const updateDraft = useSet(updateSourcesFirstDraft$);
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
  const connected = slack.kind === "connected";

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
        <div className="flex flex-col gap-2">
          <SlackChannelButton state={slack} />
          <ChannelNote
            state={slack}
            channel={t(($) => {
              return $.onboarding.sourcesFirst.slack.name;
            })}
          />
        </div>
        <OtherChatChannels
          picked={flow.draft.chatChannels}
          onPick={(channel) => {
            // iMessage is still answered here, until it becomes the
            // AgentPhone tile with a link flow of its own.
            const added = !flow.draft.chatChannels.includes(channel);
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
