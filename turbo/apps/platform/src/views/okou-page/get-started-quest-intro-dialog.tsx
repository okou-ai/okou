import type { GetStartedQuestKey } from "@okouai/api-contracts/contracts/get-started";
import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Clock, Coins, Play, User } from "lucide-react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import { assistantName$ } from "../../signals/branding.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import {
  checkinClaimedOpen$,
  getStartedQuests$,
  questIntroKey$,
  questIntroPromptShown$,
  setCheckinClaimedOpen$,
  setQuestIntroKey$,
  showQuestIntroPrompt$,
} from "../../signals/okou-page/get-started.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";
import { WorkflowConnectorIcon } from "../onboarding/onboarding-workflow-diagram.tsx";
import type { PlatformConnectorCatalogStatusItem } from "../../signals/connector-domain.ts";
import { connectorCatalogStatus$ } from "../../signals/external/connectors.ts";
import {
  selectedBuiltinConnectorSlug$,
  setSelectedBuiltinConnectorSlug$,
} from "../../signals/okou-page/settings/connectors.ts";
import { defaultBuiltinConnectorAccountOptions } from "../../signals/okou-page/settings/connector-account-dialogs.ts";
import { slackOrgData$ } from "../../signals/okou-page/slack.ts";
import { ConnectModal } from "./components/settings/add-connection-dialog.tsx";
import { QuestConnectorPicker } from "./get-started-connector-picker.tsx";
import { openFreshOAuth } from "../../lib/oauth-window.ts";
import {
  ILLUSTRATION_ACCENTS,
  LINE_ALPHA,
  NODE_CLASS,
  SOFT_ALPHA,
  TILE_ALPHA,
} from "./start-cards.tsx";

/**
 * The quests that explain themselves before they hand the user off.
 *
 * A quest earns a dialog only when it carries something its row cannot: what a
 * connector may read and how to take it back, that Slack turns a personal
 * account into an organization one, and which workflows an invited teammate
 * inherits. `share` already opens its own submission dialog and `checkin`
 * confirms afterwards, so neither is introduced here.
 */
const INTRODUCED_QUESTS = Object.freeze([
  "connector",
  "slack",
  "workflow",
  "invite",
] as const);
type IntroducedQuestKey = (typeof INTRODUCED_QUESTS)[number];

function isIntroduced(key: GetStartedQuestKey): key is IntroducedQuestKey {
  return INTRODUCED_QUESTS.some((candidate) => {
    return candidate === key;
  });
}

export function questHasIntro(key: GetStartedQuestKey): boolean {
  return isIntroduced(key);
}

/**
 * The washed tile the start cards under the composer use: one accent from the
 * avatar palette laid down at five strengths, art built from bordered card
 * nodes, and space around a small object.
 *
 * It is drawn larger than the start-card tile because this shell is a page the
 * reader stops on rather than a card in a row under the composer.
 */
const TILE_CLASS =
  "grid size-[104px] shrink-0 place-items-center overflow-hidden rounded-2xl";

/**
 * A step's tile sits beside two lines of text rather than alone on a band, so
 * it is drawn to the height of that text instead of the figure's.
 */
const STEP_TILE_CLASS =
  "grid size-[72px] shrink-0 place-items-center overflow-hidden rounded-xl";

function Tile({
  accent,
  size = "figure",
  children,
}: {
  accent: string;
  size?: "figure" | "step";
  children: ReactNode;
}) {
  return (
    <span
      className={size === "step" ? STEP_TILE_CLASS : TILE_CLASS}
      style={{ backgroundColor: `${accent}${TILE_ALPHA}` }}
    >
      {children}
    </span>
  );
}

/**
 * The illustration gets its own ground rather than floating on the dialog's
 * paper: a washed band reads as one picture and separates the drawing from the
 * sentences under it without a rule.
 *
 * The band runs edge to edge at the top of the shell, above the header, which
 * is the anatomy Atlassian's `benefits modal` states for exactly this job:
 * illustration, then title, then message, then at most two actions. Sitting it
 * inside the body instead left the drawing with padding on both sides and the
 * words beside it with nothing to line up against.
 */
function TileRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex w-full items-center justify-center gap-4 bg-state-hover px-6 py-8">
      {children}
    </div>
  );
}

/** The join: three quiet dots. Not an arrow — the tiles say which way it runs. */
function Joint({ accent }: { accent: string }) {
  return (
    <span className="flex shrink-0 items-center gap-[4px]" aria-hidden="true">
      {["a", "b", "c"].map((id) => {
        return (
          <span
            key={id}
            className="size-[3px] rounded-full"
            style={{ backgroundColor: `${accent}${LINE_ALPHA}` }}
          />
        );
      })}
    </span>
  );
}

/**
 * Okou's own face, the same asset onboarding draws. Wherever the assistant
 * appears in a figure it appears as itself, not as a label or a brand mark.
 */
const OKOU_AVATAR_IMG = platformStaticAssetUrl(
  "views/onboarding/assets/okou-avatar-2df72642115f.webp",
);

function OkouAvatar({ size }: { size: number }) {
  return (
    <img
      src={OKOU_AVATAR_IMG}
      alt=""
      aria-hidden
      className="block shrink-0 object-contain"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * A person, drawn as one glyph rather than assembled: a circle stacked over a
 * dome leaves a head floating above a shoulder at this size.
 */
function Person({ accent, size }: { accent: string; size: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full border bg-card"
      style={{
        width: size,
        height: size,
        borderColor: `${accent}${LINE_ALPHA}`,
        color: accent,
      }}
    >
      <User size={Math.round(size * 0.56)} strokeWidth={2.2} />
    </span>
  );
}

/**
 * The channel, drawn as the message card it produces.
 *
 * Two tiles joined by dots are right for a connector, where the point is that
 * two things are attached. They say nothing about what happens once the
 * assistant is in Slack: a teammate mentions it, and it answers with the app
 * badge Slack gives every bot.
 */
function SlackFigure({ assistantName }: { assistantName: string }) {
  const { t } = useTranslation();
  return (
    <TileRow>
      <span className="w-[392px] overflow-hidden rounded-xl border border-border bg-card shadow-[0_10px_26px_-18px_rgba(0,0,0,0.45)]">
        <span className="flex items-center gap-[7px] border-b border-border px-[13px] py-[9px]">
          <WorkflowConnectorIcon connectorSlug="slack" size={14} />
          <span className="text-[12px] font-semibold leading-none text-foreground">
            {t(($) => {
              return $.chat.agentPage.getStarted.intro.slack.sampleChannel;
            })}
          </span>
        </span>
        <span className="flex flex-col gap-[11px] px-[13px] py-[12px]">
          <span className="flex items-center gap-[9px]">
            <span className="grid size-[24px] shrink-0 place-items-center rounded-full bg-state-hover text-muted-foreground">
              <User size={13} strokeWidth={2.2} />
            </span>
            <span className="rounded-[4px] bg-brand-subtle px-[5px] py-[2px] text-[10px] font-semibold leading-none text-brand-text">
              {`@${assistantName.toLowerCase()}`}
            </span>
            <span className="h-[5px] w-[96px] rounded-full bg-divider" />
          </span>
          <span className="flex items-start gap-[8px]">
            <OkouAvatar size={26} />
            <span className="flex flex-col gap-[6px] pt-[1px]">
              <span className="flex items-center gap-[5px]">
                <span className="text-[12px] font-semibold leading-none text-foreground">
                  {assistantName}
                </span>
                <span className="rounded-[3px] bg-state-hover px-[4px] py-[2px] text-[8px] font-semibold uppercase leading-none text-muted-foreground">
                  {t(($) => {
                    return $.chat.agentPage.getStarted.intro.slack.appBadge;
                  })}
                </span>
              </span>
              <span className="flex flex-col gap-[5px]">
                <span className="h-[5px] w-[186px] rounded-full bg-divider" />
                <span className="h-[5px] w-[132px] rounded-full bg-divider" />
              </span>
            </span>
          </span>
        </span>
      </span>
    </TileRow>
  );
}

/** One saved workflow, handed to everyone who joins. */
function InviteFigure() {
  // Terracotta, the avatar palette's colour for people.
  const accent = ILLUSTRATION_ACCENTS.avatar;
  return (
    <TileRow>
      <Tile accent={accent}>
        <span
          className={`flex h-[48px] w-[64px] flex-col justify-center gap-[7px] px-[11px] ${NODE_CLASS}`}
          style={{ borderColor: `${accent}${LINE_ALPHA}` }}
        >
          <span
            className="h-[3px] w-[22px] rounded-full"
            style={{ backgroundColor: accent }}
          />
          <span
            className="h-[3px] w-[34px] rounded-full"
            style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
          />
        </span>
      </Tile>
      <Joint accent={accent} />
      <Tile accent={accent}>
        <span className="flex items-center gap-[5px]">
          {["a", "b", "c"].map((id) => {
            return <Person key={id} accent={accent} size={28} />;
          })}
        </span>
      </Tile>
    </TileRow>
  );
}

/**
 * What comes back from a job: a small table, because the prompt this figure
 * sits above asks for one. The point of the drawing is that the reply is an
 * artifact, not a paragraph.
 */
function ReportArt({ accent }: { accent: string }) {
  return (
    <span
      className={`flex h-[48px] w-[64px] flex-col justify-center gap-[5px] px-[9px] ${NODE_CLASS}`}
      style={{ borderColor: `${accent}${LINE_ALPHA}` }}
    >
      <span className="flex gap-[4px]">
        <span
          className="h-[4px] w-[14px] rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span
          className="h-[4px] w-[10px] rounded-full"
          style={{ backgroundColor: accent }}
        />
        <span
          className="h-[4px] w-[12px] rounded-full"
          style={{ backgroundColor: accent }}
        />
      </span>
      {["a", "b"].map((row) => {
        return (
          <span key={row} className="flex gap-[4px]">
            <span
              className="h-[3px] w-[14px] rounded-full"
              style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
            />
            <span
              className="h-[3px] w-[10px] rounded-full"
              style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
            />
            <span
              className="h-[3px] w-[12px] rounded-full"
              style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
            />
          </span>
        );
      })}
    </span>
  );
}

/** You ask in one sentence; what comes back is the finished thing. */
function PromptFigure() {
  const accent = ILLUSTRATION_ACCENTS.website;
  return (
    <TileRow>
      <Tile accent={accent}>
        <OkouAvatar size={64} />
      </Tile>
      <Joint accent={accent} />
      <Tile accent={accent}>
        <ReportArt accent={accent} />
      </Tile>
    </TileRow>
  );
}

/**
 * The check-in illustration: the brand drawing of a day signed off. The dialog
 * it opens is the one moment in the checklist that is purely a reward, so it
 * carries a full picture rather than a row of tiles.
 */
const CHECKIN_ILLUSTRATION_IMG = platformStaticAssetUrl(
  "views/okou-page/assets/get-started-checkin-269a14fb7633.webp",
);

function CheckinFigure() {
  return (
    <div className="flex w-full items-center justify-center rounded-2xl bg-state-hover px-6 py-6">
      <img
        src={CHECKIN_ILLUSTRATION_IMG}
        alt=""
        aria-hidden
        className="block h-auto w-[320px] max-w-full"
      />
    </div>
  );
}

/** Step 1: a list of ready-made workflows with one of them chosen. */
function TemplateArt({ accent }: { accent: string }) {
  return (
    <span
      className={`flex h-[48px] w-[64px] flex-col justify-center gap-[6px] px-[11px] ${NODE_CLASS}`}
      style={{ borderColor: `${accent}${LINE_ALPHA}` }}
    >
      <span
        className="h-[3px] w-[24px] rounded-full"
        style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
      />
      <span
        className="h-[3px] w-[28px] rounded-full"
        style={{ backgroundColor: accent }}
      />
      <span
        className="h-[3px] w-[16px] rounded-full"
        style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
      />
    </span>
  );
}

/** Step 2: it runs once, and the result is already there. */
function RunArt({ accent }: { accent: string }) {
  return (
    <span
      className={`grid h-[48px] w-[64px] place-items-center ${NODE_CLASS}`}
      style={{ borderColor: `${accent}${LINE_ALPHA}` }}
    >
      <span
        className="grid size-[22px] place-items-center rounded-full"
        style={{ backgroundColor: `${accent}${SOFT_ALPHA}`, color: accent }}
      >
        <Play size={10} fill="currentColor" />
      </span>
    </span>
  );
}

/** Step 3: saved, and from then on it keeps its own time. */
function SaveArt({ accent }: { accent: string }) {
  return (
    <span
      className={`grid h-[48px] w-[64px] place-items-center ${NODE_CLASS}`}
      style={{ borderColor: `${accent}${LINE_ALPHA}`, color: accent }}
    >
      <Clock size={22} strokeWidth={2} />
    </span>
  );
}

/**
 * One of the three steps, drawn the way the start cards below the composer are:
 * an illustrated tile, a title, and the sentence that explains it. The step is
 * recognisable before it is read, and the row it forms is the same object the
 * user already sees on the page it opens over.
 */
function WorkflowStep({
  art,
  title,
  description,
}: {
  art: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-center gap-4 py-2">
      {art}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
    </div>
  );
}

/**
 * The sentence under the figure, for the quests where the reason to do it is
 * about the reader rather than about the feature. It is prose, not a list of
 * properties: what changes for them once the step is done.
 */
function IntroNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-0.5 text-[13px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * The shape every quest intro takes: what it is worth, a drawing of it, the
 * detail the row could not hold, and one way forward that is not a dead end.
 */
function IntroLayout({
  title,
  description,
  reward,
  figure,
  secondaryLabel,
  onSecondary,
  confirmLabel,
  onConfirm,
  children,
}: {
  title: string;
  description: string;
  /** What the step pays, when the quest carries a reward. */
  reward?: number;
  figure?: ReactNode;
  secondaryLabel: string;
  onSecondary: () => void;
  confirmLabel: string;
  onConfirm: () => void;
  /** Only the quests that hand something over draw a body under the figure. */
  children?: ReactNode;
}) {
  return (
    <>
      {/* The drawing runs edge to edge above the header, so it escapes the
          body's padding rather than sitting inside it. The close button is
          light-on-washed either way, so it needs no ground of its own. */}
      {figure !== undefined && <div className="-mx-6 -mt-6">{figure}</div>}
      <DialogHeader>
        {/* The close button is absolutely placed at the top right, so a title
            long enough to wrap runs underneath it without this inset. */}
        <DialogTitle className="pr-7">{title}</DialogTitle>
        {/* The price rides the description: the title is the argument, and what
            the step pays is a fact about it. The row that led here is the only
            place it used to appear, which is the one place the decision is not
            being made. */}
        <div className="flex flex-wrap items-center gap-2">
          <DialogDescription>{description}</DialogDescription>
          {reward !== undefined && (
            <Badge className="shrink-0 text-xs font-semibold tabular-nums text-brand-text">
              <Coins />+{formatLocalizedNumber(reward)}
            </Badge>
          )}
        </div>
      </DialogHeader>
      {children !== undefined && (
        <div className="flex flex-col gap-3">{children}</div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onSecondary}>
          {secondaryLabel}
        </Button>
        <Button
          type="button"
          onClick={onConfirm}
          data-testid="quest-intro-confirm"
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

interface IntroProps {
  readonly onConfirm: () => void;
  readonly onClose: () => void;
  /** What this step pays, read off the quest the panel already loaded. */
  readonly reward?: number;
}

function useLaterLabel(): string {
  const { t } = useTranslation();
  return t(($) => {
    return $.chat.agentPage.getStarted.intro.later;
  });
}

function ConnectorIntro({
  onConfirm,
  onClose,
  reward,
  onNeedsChoice,
}: IntroProps & {
  readonly onNeedsChoice: (
    connector: PlatformConnectorCatalogStatusItem,
  ) => void;
}) {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  return (
    <IntroLayout
      title={t(
        ($) => {
          return $.chat.agentPage.getStarted.intro.connector.title;
        },
        { assistantName },
      )}
      description={t(
        ($) => {
          return $.chat.agentPage.getStarted.intro.connector.description;
        },
        { assistantName },
      )}
      // The connectors themselves are the illustration: every one of them
      // connects in one press, which is the claim the abstract figure was
      // making and these marks make better.
      reward={reward}
      figure={<QuestConnectorPicker onNeedsChoice={onNeedsChoice} />}
      secondaryLabel={useLaterLabel()}
      onSecondary={onClose}
      confirmLabel={t(($) => {
        return $.chat.agentPage.getStarted.intro.connector.confirm;
      })}
      onConfirm={onConfirm}
    />
  );
}

/**
 * Slack, with the install itself on the confirm button.
 *
 * The step used to hand the reader to the integrations list and leave them to
 * find Slack in it, which is a page of other people's logos between them and
 * the thing the row asked for. The status this dialog reads already carries the
 * workspace's install URL, so confirming starts the authorization the way the
 * connector step does — the same reason that one shows the catalog rather than
 * a link to it.
 *
 * The URL is read while the dialog is open and spent inside the click, because
 * a `window.open` that waits on a request first is no longer a user gesture.
 * Without one, confirm falls back to the list.
 */
function SlackIntro({ onConfirm, onClose, reward }: IntroProps) {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const slackLoadable = useLastLoadable(slackOrgData$);
  const slack = slackLoadable.state === "hasData" ? slackLoadable.data : null;
  const installUrl =
    slack && slack.isAdmin && slack.isInstalled !== true
      ? (slack.installUrl ?? null)
      : null;
  return (
    <IntroLayout
      title={t(($) => {
        return $.chat.agentPage.getStarted.intro.slack.title;
      })}
      description={t(
        ($) => {
          return $.chat.agentPage.getStarted.intro.slack.description;
        },
        { assistantName },
      )}
      reward={reward}
      figure={<SlackFigure assistantName={assistantName} />}
      secondaryLabel={useLaterLabel()}
      onSecondary={onClose}
      confirmLabel={t(($) => {
        return $.chat.agentPage.getStarted.intro.slack.confirm;
      })}
      onConfirm={() => {
        if (installUrl === null) {
          onConfirm();
          return;
        }
        openFreshOAuth(installUrl);
        onClose();
      }}
    >
      <IntroNote>
        {t(($) => {
          return $.chat.agentPage.getStarted.intro.slack.note;
        })}
      </IntroNote>
    </IntroLayout>
  );
}

function InviteIntro({ onConfirm, onClose, reward }: IntroProps) {
  const { t } = useTranslation();
  return (
    <IntroLayout
      title={t(($) => {
        return $.chat.agentPage.getStarted.intro.invite.title;
      })}
      description={t(($) => {
        return $.chat.agentPage.getStarted.intro.invite.description;
      })}
      reward={reward}
      figure={<InviteFigure />}
      secondaryLabel={useLaterLabel()}
      onSecondary={onClose}
      confirmLabel={t(($) => {
        return $.chat.agentPage.getStarted.intro.invite.confirm;
      })}
      onConfirm={onConfirm}
    >
      <IntroNote>
        {t(($) => {
          return $.chat.agentPage.getStarted.intro.invite.note;
        })}
      </IntroNote>
    </IntroLayout>
  );
}

/** The three steps, before any of them is asked for. */
function WorkflowStepsIntro({ onConfirm, onClose, reward }: IntroProps) {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  return (
    <IntroLayout
      title={t(
        ($) => {
          return $.chat.agentPage.getStarted.intro.workflow.title;
        },
        { assistantName },
      )}
      description={t(($) => {
        return $.chat.agentPage.getStarted.intro.workflow.description;
      })}
      reward={reward}
      secondaryLabel={useLaterLabel()}
      onSecondary={onClose}
      confirmLabel={t(($) => {
        return $.chat.agentPage.getStarted.intro.workflow.confirm;
      })}
      onConfirm={onConfirm}
    >
      <div>
        <WorkflowStep
          art={
            <Tile accent={ILLUSTRATION_ACCENTS.illustration} size="step">
              <TemplateArt accent={ILLUSTRATION_ACCENTS.illustration} />
            </Tile>
          }
          title={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow.stepTemplate;
          })}
          description={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow
              .stepTemplateDescription;
          })}
        />
        <WorkflowStep
          art={
            <Tile accent={ILLUSTRATION_ACCENTS.website} size="step">
              <RunArt accent={ILLUSTRATION_ACCENTS.website} />
            </Tile>
          }
          title={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow.stepRun;
          })}
          description={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow
              .stepRunDescription;
          })}
        />
        <WorkflowStep
          art={
            <Tile accent={ILLUSTRATION_ACCENTS.slides} size="step">
              <SaveArt accent={ILLUSTRATION_ACCENTS.slides} />
            </Tile>
          }
          title={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow.stepSave;
          })}
          description={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow
              .stepSaveDescription;
          })}
        />
      </div>
    </IntroLayout>
  );
}

/**
 * The sentence that starts the first step.
 *
 * The prompt is the payload of this dialog, so it is shown as text the reader
 * can judge and edit later rather than hidden behind the button that sends it.
 */
function WorkflowPromptIntro({
  onSend,
  onBrowse,
  reward,
}: {
  onSend: (prompt: string) => void;
  onBrowse: () => void;
  reward?: number;
}) {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const prompt = t(($) => {
    return $.chat.agentPage.getStarted.intro.workflow.prompt;
  });
  return (
    <IntroLayout
      title={t(
        ($) => {
          return $.chat.agentPage.getStarted.intro.workflow.promptTitle;
        },
        { assistantName },
      )}
      description={t(($) => {
        return $.chat.agentPage.getStarted.intro.workflow.promptDescription;
      })}
      secondaryLabel={t(($) => {
        return $.chat.agentPage.getStarted.intro.workflow.browse;
      })}
      onSecondary={onBrowse}
      confirmLabel={t(
        ($) => {
          return $.chat.agentPage.getStarted.intro.workflow.promptConfirm;
        },
        { assistantName },
      )}
      reward={reward}
      onConfirm={() => {
        onSend(prompt);
      }}
      figure={<PromptFigure />}
    >
      {/* The sentence is the point of this screen, so it is set as the thing
          being handed over rather than as a field in a form. */}
      <p className="rounded-xl border border-surface-border bg-card px-4 py-3.5 text-[15px] leading-relaxed text-foreground">
        {prompt}
      </p>
      <p className="px-0.5 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.agentPage.getStarted.intro.workflow.promptOutcome;
        })}
      </p>
    </IntroLayout>
  );
}

function WorkflowIntro({ onConfirm, onClose, reward }: IntroProps) {
  const showPrompt = useGet(questIntroPromptShown$);
  const advance = useSet(showQuestIntroPrompt$);
  const navigate = useSet(detachedNavigateTo$);

  return showPrompt ? (
    <WorkflowPromptIntro
      reward={reward}
      onSend={(prompt) => {
        const searchParams = new URLSearchParams();
        searchParams.set("prompt", prompt);
        // The composer picks the prompt up on arrival, so the user lands in a
        // chat that is already filled in rather than on an empty page.
        navigate(ROUTES.home, { searchParams });
        onClose();
      }}
      onBrowse={onConfirm}
    />
  ) : (
    <WorkflowStepsIntro
      onConfirm={() => {
        advance();
      }}
      onClose={onClose}
      reward={reward}
    />
  );
}

/**
 * Says what a quest is worth before the app hands the user off.
 *
 * `onConfirm` runs the same handoff the row ran on its own, so the dialog only
 * adds the explanation; it never becomes the thing that does the work.
 */
export function GetStartedQuestIntroDialog({
  onConfirm,
}: {
  onConfirm: (key: GetStartedQuestKey) => void;
}) {
  const openKey = useGet(questIntroKey$);
  const setOpenKey = useSet(setQuestIntroKey$);
  const setSelectedSlug = useSet(setSelectedBuiltinConnectorSlug$);
  const introducedKey =
    openKey !== null && isIntroduced(openKey) ? openKey : null;

  const close = () => {
    setOpenKey(null);
  };
  const confirm = () => {
    if (introducedKey !== null) {
      onConfirm(introducedKey);
    }
    close();
  };
  // The quest list the panel already loaded is where the price lives, so the
  // dialog reads it rather than being handed a second copy of the same number.
  const quests = useLastLoadable(getStartedQuests$);
  const reward =
    quests.state === "hasData" && introducedKey !== null
      ? quests.data.find((quest) => {
          return quest.key === introducedKey;
        })?.rewardAmount
      : undefined;
  const props: IntroProps = { onConfirm: confirm, onClose: close, reward };
  const needsChoice = (connector: PlatformConnectorCatalogStatusItem) => {
    setSelectedSlug(connector.slug);
  };

  // The dialog stays mounted and closed rather than appearing already open:
  // a popup that is born open never runs its enter transition, so its portal
  // has nothing to show.
  return (
    <>
      <Dialog
        open={introducedKey !== null}
        onOpenChange={(next) => {
          if (!next) {
            close();
          }
        }}
      >
        <DialogContent
          // Two widths, by what the body is. The connector step carries the
          // whole one-click catalog and needs the room; a step whose body is a
          // drawing and three lines reads better narrow, because a single
          // illustration centred across 680 cannot fill it. 560 is the nearest
          // width the shell registers, and the one the check-in already uses.
          smMaxWidth={introducedKey === "connector" ? 760 : 560}
        >
          {introducedKey === "connector" && (
            <ConnectorIntro {...props} onNeedsChoice={needsChoice} />
          )}
          {introducedKey === "slack" && <SlackIntro {...props} />}
          {introducedKey === "invite" && <InviteIntro {...props} />}
          {introducedKey === "workflow" && (
            <WorkflowIntro
              onConfirm={confirm}
              onClose={close}
              reward={reward}
            />
          )}
        </DialogContent>
      </Dialog>
      <QuestConnectModal />
    </>
  );
}

/**
 * The connect flow a picked connector opens.
 *
 * It is mounted beside the intro rather than inside it so that cancelling the
 * connection returns the reader to the list they picked from, and so the flow
 * is not unmounted mid-authorization if the intro closes underneath it.
 */
function QuestConnectModal() {
  const selectedSlug = useGet(selectedBuiltinConnectorSlug$);
  const setSelectedSlug = useSet(setSelectedBuiltinConnectorSlug$);
  const catalogLoadable = useLastLoadable(connectorCatalogStatus$);
  const selected =
    selectedSlug !== null && catalogLoadable.state === "hasData"
      ? catalogLoadable.data.connectors.find((connector) => {
          return connector.slug === selectedSlug;
        })
      : undefined;
  const accountOptions = defaultBuiltinConnectorAccountOptions(selected);
  if (!selected || !accountOptions) {
    return null;
  }
  return (
    <ConnectModal
      item={selected}
      accountOptions={accountOptions}
      authorizeVisibleAgentsOnConnect
      onClose={() => {
        setSelectedSlug(null);
      }}
    />
  );
}

/** Confirms the daily check-in that already succeeded. */
export function GetStartedCheckinDialog({ reward }: { reward: number }) {
  const { t } = useTranslation();
  const open = useGet(checkinClaimedOpen$);
  const setOpen = useSet(setCheckinClaimedOpen$);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent smMaxWidth={560}>
        <CheckinFigure />
        {/* The one screen in the checklist that is purely a reward, so it is
            centred and reads top to bottom: the mark, what was earned, what it
            is for, and where the checklist now stands. */}
        <DialogHeader className="items-center text-center">
          <DialogTitle className="text-xl">
            {t(($) => {
              return $.chat.agentPage.getStarted.intro.checkin.title;
            })}
          </DialogTitle>
          <p className="text-3xl font-semibold tabular-nums tracking-tight text-brand-text">
            {t(
              ($) => {
                return $.chat.agentPage.getStarted.intro.checkin.amount;
              },
              { amount: formatLocalizedNumber(reward) },
            )}
          </p>
          <DialogDescription className="max-w-[380px]">
            {t(($) => {
              return $.chat.agentPage.getStarted.intro.checkin.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-center">
          <Button
            type="button"
            className="min-w-[160px]"
            onClick={() => {
              setOpen(false);
            }}
          >
            {t(($) => {
              return $.chat.agentPage.getStarted.intro.checkin.confirm;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
