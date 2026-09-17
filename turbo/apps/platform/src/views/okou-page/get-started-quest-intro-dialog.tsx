import type { GetStartedQuestKey } from "@okouai/api-contracts/contracts/get-started";
import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Clock, Play, User } from "lucide-react";
import {
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
import {
  checkinClaimedOpen$,
  questIntroKey$,
  questIntroPromptShown$,
  setCheckinClaimedOpen$,
  setQuestIntroKey$,
  showQuestIntroPrompt$,
} from "../../signals/okou-page/get-started.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";
import { WorkflowConnectorIcon } from "../onboarding/onboarding-workflow-diagram.tsx";

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
 * The illustration language the onboarding workflow diagram already uses for
 * exactly this kind of picture: card tiles on the illustration stroke with a
 * soft lift, real connector marks inside them, and nodes joined by a line with
 * a waypoint at each end. No arrowheads — the line is the relationship, and
 * the tiles on either side say which way it runs.
 */
const FIGURE_TILE_CLASS =
  "inline-flex items-center justify-center overflow-hidden rounded-2xl border-(length:--border-width-illustration) border-solid border-border bg-card shadow-[0_12px_30px_-18px_rgba(0,0,0,0.5)]";

/* The artwork's own orange and ink, literal for the same reason the diagram
   keeps them literal: they are artwork, and the theme tokens flip in Dark. */
const FIGURE_LINE_COLOR = "#ed7a44";
const FIGURE_DOT_CLASS =
  "box-border size-[7px] shrink-0 rounded-full border-(length:--border-width-illustration-marker) border-solid border-[#ffffff] bg-[#29292e]";

function FigureTile({ size, children }: { size: number; children: ReactNode }) {
  return (
    <span className={FIGURE_TILE_CLASS} style={{ width: size, height: size }}>
      {children}
    </span>
  );
}

/** The join: a run of line with a waypoint at each end, and no arrow. */
function FigureJoin() {
  return (
    <span className="flex shrink-0 items-center" aria-hidden="true">
      <span className={FIGURE_DOT_CLASS} />
      <span
        className="h-[2px] w-[22px] rounded-full"
        style={{ backgroundColor: FIGURE_LINE_COLOR }}
      />
      <span className={FIGURE_DOT_CLASS} />
    </span>
  );
}

/** Three marks in one slot, the way the diagram shows several sources. */
function FigureStack({ children }: { children: readonly ReactNode[] }) {
  return (
    <span className="relative block size-[42px]">
      {children.map((child, index) => {
        return (
          <span
            key={STACK_POSITIONS[index]}
            className={`absolute size-[26px] rounded-[9px] ${FIGURE_TILE_CLASS} ${STACK_POSITIONS[index]}`}
          >
            {child}
          </span>
        );
      })}
    </span>
  );
}

const STACK_POSITIONS = [
  "top-0 left-0",
  "top-0 right-0",
  "bottom-0 left-[8px]",
] as const;

/**
 * The illustration gets its own ground rather than floating on the dialog's
 * paper: a washed band reads as one picture, and it separates the drawing from
 * the sentences under it without a rule.
 */
function TileRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-[10px] rounded-xl bg-state-hover px-4 py-6">
      {children}
    </div>
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

function OkouNode() {
  return (
    <FigureTile size={56}>
      <OkouAvatar size={44} />
    </FigureTile>
  );
}

/** A person, one glyph, in the same tile the marks sit in. */
function PersonMark({ size }: { size: number }) {
  return <User size={size} strokeWidth={2} className="text-muted-foreground" />;
}

/** Okou joined to the accounts it will read: three of the user's own tools. */
function ConnectorFigure() {
  return (
    <TileRow>
      <OkouNode />
      <FigureJoin />
      <FigureTile size={56}>
        <FigureStack>
          {[
            <WorkflowConnectorIcon
              key="gmail"
              connectorSlug="gmail"
              size={18}
            />,
            <WorkflowConnectorIcon
              key="notion"
              connectorSlug="notion"
              size={18}
            />,
            <WorkflowConnectorIcon
              key="calendar"
              connectorSlug="google-calendar"
              size={18}
            />,
          ]}
        </FigureStack>
      </FigureTile>
    </TileRow>
  );
}

/** Okou moves into Slack, where the team already is. */
function SlackFigure() {
  return (
    <TileRow>
      <OkouNode />
      <FigureJoin />
      <FigureTile size={56}>
        <WorkflowConnectorIcon connectorSlug="slack" size={34} />
      </FigureTile>
      <FigureJoin />
      <FigureTile size={56}>
        <FigureStack>
          {[
            <PersonMark key="a" size={15} />,
            <PersonMark key="b" size={15} />,
            <PersonMark key="c" size={15} />,
          ]}
        </FigureStack>
      </FigureTile>
    </TileRow>
  );
}

/** One saved workflow, handed to everyone who joins. */
function InviteFigure() {
  return (
    <TileRow>
      <FigureTile size={56}>
        <span className="flex w-[34px] flex-col gap-[5px]">
          <span
            className="h-[3px] w-[22px] rounded-full"
            style={{ backgroundColor: FIGURE_LINE_COLOR }}
          />
          <span className="h-[3px] w-full rounded-full bg-divider" />
          <span className="h-[3px] w-[24px] rounded-full bg-divider" />
        </span>
      </FigureTile>
      <FigureJoin />
      <FigureTile size={56}>
        <FigureStack>
          {[
            <PersonMark key="a" size={15} />,
            <PersonMark key="b" size={15} />,
            <PersonMark key="c" size={15} />,
          ]}
        </FigureStack>
      </FigureTile>
    </TileRow>
  );
}

/** Step 1: a list of ready-made workflows with one of them chosen. */
function TemplateArt() {
  return (
    <span className="flex w-[30px] flex-col gap-[4px]">
      <span className="h-[3px] w-full rounded-full bg-divider" />
      <span
        className="h-[3px] w-full rounded-full"
        style={{ backgroundColor: FIGURE_LINE_COLOR }}
      />
      <span className="h-[3px] w-[18px] rounded-full bg-divider" />
    </span>
  );
}

/** Step 2: it runs once, and the result is already there. */
function RunArt() {
  return (
    <span
      className="grid size-[26px] place-items-center rounded-full border-(length:--border-width-illustration) border-solid"
      style={{ borderColor: FIGURE_LINE_COLOR, color: FIGURE_LINE_COLOR }}
    >
      <Play size={11} fill="currentColor" />
    </span>
  );
}

/** Step 3: saved, and from then on it keeps its own time. */
function SaveArt() {
  return (
    <span style={{ color: FIGURE_LINE_COLOR }}>
      <Clock size={26} strokeWidth={1.8} />
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
    <div className="flex items-center gap-3 py-1.5">
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

function ScopeNote({ items }: { items: readonly string[] }) {
  return (
    <ul className="px-0.5 text-xs text-muted-foreground">
      {items.map((item) => {
        return (
          <li key={item} className="py-[3px]">
            {item}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The shape every quest intro takes: what it is worth, a drawing of it, the
 * detail the row could not hold, and one way forward that is not a dead end.
 */
function IntroLayout({
  title,
  description,
  figure,
  secondaryLabel,
  onSecondary,
  confirmLabel,
  onConfirm,
  children,
}: {
  title: string;
  description: string;
  figure?: ReactNode;
  secondaryLabel: string;
  onSecondary: () => void;
  confirmLabel: string;
  onConfirm: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <DialogHeader>
        {/* The close button is absolutely placed at the top right, so a title
            long enough to wrap runs underneath it without this inset. */}
        <DialogTitle className="pr-7">{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3">
        {figure}
        {children}
      </div>
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
}

function useLaterLabel(): string {
  const { t } = useTranslation();
  return t(($) => {
    return $.chat.agentPage.getStarted.intro.later;
  });
}

function ConnectorIntro({ onConfirm, onClose }: IntroProps) {
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
      description={t(($) => {
        return $.chat.agentPage.getStarted.intro.connector.description;
      })}
      figure={<ConnectorFigure />}
      secondaryLabel={useLaterLabel()}
      onSecondary={onClose}
      confirmLabel={t(($) => {
        return $.chat.agentPage.getStarted.intro.connector.confirm;
      })}
      onConfirm={onConfirm}
    >
      {/* Refusals here are about custody, not value: what it may read, how
          little it asks for, and how to take it back. */}
      <ScopeNote
        items={[
          t(
            ($) => {
              return $.chat.agentPage.getStarted.intro.connector
                .scopeCredentials;
            },
            { assistantName },
          ),
          t(($) => {
            return $.chat.agentPage.getStarted.intro.connector.scopeRevoke;
          }),
        ]}
      />
    </IntroLayout>
  );
}

function SlackIntro({ onConfirm, onClose }: IntroProps) {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
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
      figure={<SlackFigure />}
      secondaryLabel={useLaterLabel()}
      onSecondary={onClose}
      confirmLabel={t(($) => {
        return $.chat.agentPage.getStarted.intro.slack.confirm;
      })}
      onConfirm={onConfirm}
    >
      {/* The row's footnote says the Slack reward goes to the organization.
          That is the point of this quest, not a disclaimer, so it leads here. */}
      <ScopeNote
        items={[
          t(($) => {
            return $.chat.agentPage.getStarted.intro.slack.scopeOrganization;
          }),
          t(($) => {
            return $.chat.agentPage.getStarted.intro.slack.scopeReward;
          }),
          t(($) => {
            return $.chat.agentPage.getStarted.intro.slack.scopeChannels;
          }),
        ]}
      />
    </IntroLayout>
  );
}

function InviteIntro({ onConfirm, onClose }: IntroProps) {
  const { t } = useTranslation();
  return (
    <IntroLayout
      title={t(($) => {
        return $.chat.agentPage.getStarted.intro.invite.title;
      })}
      description={t(($) => {
        return $.chat.agentPage.getStarted.intro.invite.description;
      })}
      figure={<InviteFigure />}
      secondaryLabel={useLaterLabel()}
      onSecondary={onClose}
      confirmLabel={t(($) => {
        return $.chat.agentPage.getStarted.intro.invite.confirm;
      })}
      onConfirm={onConfirm}
    >
      <ScopeNote
        items={[
          t(($) => {
            return $.chat.agentPage.getStarted.intro.invite.scopeShared;
          }),
        ]}
      />
    </IntroLayout>
  );
}

/** The three steps, before any of them is asked for. */
function WorkflowStepsIntro({ onConfirm, onClose }: IntroProps) {
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
            <FigureTile size={48}>
              <TemplateArt />
            </FigureTile>
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
            <FigureTile size={48}>
              <RunArt />
            </FigureTile>
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
            <FigureTile size={48}>
              <SaveArt />
            </FigureTile>
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
}: {
  onSend: (prompt: string) => void;
  onBrowse: () => void;
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
      onConfirm={() => {
        onSend(prompt);
      }}
    >
      <p className="rounded-surface-compact border border-surface-border px-3 py-2.5 text-sm">
        {prompt}
      </p>
    </IntroLayout>
  );
}

function WorkflowIntro({ onConfirm, onClose }: IntroProps) {
  const showPrompt = useGet(questIntroPromptShown$);
  const advance = useSet(showQuestIntroPrompt$);
  const navigate = useSet(detachedNavigateTo$);

  return showPrompt ? (
    <WorkflowPromptIntro
      onSend={(prompt) => {
        const searchParams = new URLSearchParams();
        searchParams.set("prompt", prompt);
        // The composer picks the prompt up on arrival, so the user lands in a
        // chat that is already filled in rather than on an empty page.
        navigate("/", { searchParams });
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
  const props: IntroProps = { onConfirm: confirm, onClose: close };

  // The dialog stays mounted and closed rather than appearing already open:
  // a popup that is born open never runs its enter transition, so its portal
  // has nothing to show.
  return (
    <Dialog
      open={introducedKey !== null}
      onOpenChange={(next) => {
        if (!next) {
          close();
        }
      }}
    >
      <DialogContent smMaxWidth="sm" maxWidth={440}>
        {introducedKey === "connector" && <ConnectorIntro {...props} />}
        {introducedKey === "slack" && <SlackIntro {...props} />}
        {introducedKey === "invite" && <InviteIntro {...props} />}
        {introducedKey === "workflow" && (
          <WorkflowIntro onConfirm={confirm} onClose={close} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Confirms the daily check-in that already succeeded. */
export function GetStartedCheckinDialog({ reward }: { reward: number }) {
  const { t } = useTranslation();
  const open = useGet(checkinClaimedOpen$);
  const setOpen = useSet(setCheckinClaimedOpen$);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent smMaxWidth="sm" maxWidth={420}>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.chat.agentPage.getStarted.intro.checkin.title;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.chat.agentPage.getStarted.intro.checkin.description;
              },
              { amount: formatLocalizedNumber(reward) },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
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
