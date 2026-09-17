import type { GetStartedQuestKey } from "@okouai/api-contracts/contracts/get-started";
import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
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
 * A figure, not a control.
 *
 * Each dialog opens on a drawing of the state it is about to change, because a
 * sentence about "your tools" or "the whole team" is abstract until the reader
 * sees the before and the after side by side.
 */
function Figure({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-surface-compact bg-state-hover p-3">
      <svg
        viewBox="0 0 280 78"
        className="block h-auto w-full"
        fill="none"
        aria-hidden="true"
      >
        {children}
      </svg>
    </div>
  );
}

function ConnectorFigure({ assistantName }: { assistantName: string }) {
  return (
    <Figure>
      <rect
        x="6"
        y="22"
        width="56"
        height="34"
        rx="9"
        className="fill-primary"
      />
      <text
        x="34"
        y="44"
        textAnchor="middle"
        className="fill-primary-foreground text-[13px] font-semibold"
      >
        {assistantName}
      </text>
      <path
        d="M66 39h40"
        className="stroke-divider"
        strokeWidth={1.6}
        strokeDasharray="4 3"
      />
      <circle
        cx="118"
        cy="39"
        r="12"
        className="stroke-brand-text"
        strokeWidth={1.5}
      />
      <path
        d="M113 39h10M118 34v10"
        className="stroke-brand-text"
        strokeWidth={1.7}
        strokeLinecap="round"
      />
      <path
        d="M130 39h24M154 39v-22h14M154 39h14M154 39v22h14"
        className="stroke-divider"
        strokeWidth={1.6}
      />
      {/* Three of the user's own tools, drawn rather than named: the row
          underneath already lists which ones, and a brand set baked into a
          figure goes stale the moment the recommendations change. */}
      {[7, 28, 49].map((y) => {
        return (
          <g key={y}>
            <rect
              x="170"
              y={y}
              width="52"
              height="22"
              rx="6"
              className="fill-card stroke-divider"
              strokeWidth={1}
            />
            <rect
              x="180"
              y={y + 7}
              width="8"
              height="8"
              rx="2"
              className="fill-divider"
            />
            <rect
              x="193"
              y={y + 8}
              width="20"
              height="2.5"
              rx="1.25"
              className="fill-divider"
            />
            <rect
              x="193"
              y={y + 13}
              width="12"
              height="2.5"
              rx="1.25"
              className="fill-divider"
            />
          </g>
        );
      })}
    </Figure>
  );
}

function SlackFigure() {
  return (
    <Figure>
      <rect
        x="4"
        y="18"
        width="72"
        height="44"
        rx="9"
        className="fill-card stroke-divider"
        strokeWidth={1}
      />
      <circle cx="40" cy="34" r="9" className="fill-divider" />
      <path d="M29 52c2-7 20-7 22 0" className="fill-divider" />
      <path d="M86 40h24" className="stroke-brand-text" strokeWidth={1.8} />
      <path
        d="M104 35l6 5-6 5"
        className="stroke-brand-text"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect
        x="120"
        y="10"
        width="156"
        height="58"
        rx="9"
        className="fill-card stroke-divider"
        strokeWidth={1}
      />
      {[136, 152, 168].map((cx) => {
        return (
          <circle key={cx} cx={cx} cy="42" r="8" className="fill-divider" />
        );
      })}
      <circle cx="186" cy="42" r="9.5" className="fill-primary" />
      <text
        x="186"
        y="46"
        textAnchor="middle"
        className="fill-primary-foreground text-[10px] font-semibold"
      >
        @
      </text>
      <rect
        x="204"
        y="33"
        width="60"
        height="18"
        rx="5"
        className="fill-state-hover"
      />
    </Figure>
  );
}

function InviteFigure() {
  return (
    <Figure>
      <rect
        x="86"
        y="8"
        width="108"
        height="30"
        rx="8"
        className="fill-brand-subtle stroke-brand-text"
        strokeWidth={1.2}
      />
      <path
        d="M140 40v8M140 48H44v10M140 48h96v10M140 48v10"
        className="stroke-divider"
        strokeWidth={1.6}
      />
      {[44, 140, 236].map((cx) => {
        return (
          <circle key={cx} cx={cx} cy="66" r="9" className="fill-divider" />
        );
      })}
    </Figure>
  );
}

/** One of the three things a saved workflow is made of. */
function WorkflowStep({
  index,
  title,
  description,
}: {
  index: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex gap-3 py-2">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-subtle text-xs font-semibold tabular-nums text-brand-text">
        {formatLocalizedNumber(index)}
      </span>
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
    <ul className="rounded-surface-compact bg-state-hover px-3 py-2.5 text-xs text-muted-foreground">
      {items.map((item) => {
        return (
          <li key={item} className="py-0.5">
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
        <DialogTitle>{title}</DialogTitle>
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
      figure={<ConnectorFigure assistantName={assistantName} />}
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
            return $.chat.agentPage.getStarted.intro.connector.scopeMinimum;
          }),
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
          t(($) => {
            return $.chat.agentPage.getStarted.intro.invite.scopeConnectors;
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
          index={1}
          title={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow.stepTemplate;
          })}
          description={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow
              .stepTemplateDescription;
          })}
        />
        <WorkflowStep
          index={2}
          title={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow.stepRun;
          })}
          description={t(($) => {
            return $.chat.agentPage.getStarted.intro.workflow
              .stepRunDescription;
          })}
        />
        <WorkflowStep
          index={3}
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
