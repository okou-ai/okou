import type { GetStartedQuestKey } from "@okouai/api-contracts/contracts/get-started";
import type { ReactNode } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  CalendarCheck,
  Check,
  ChevronRight,
  Coins,
  Link2,
  Route,
  UserPlus,
} from "lucide-react";
import {
  Button,
  buttonVariants,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";
import { assistantName$ } from "../../signals/branding.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { openSettingsDialogAt$ } from "../../signals/okou-page/settings/settings-dialog.ts";
import {
  checkInGetStarted$,
  isCheckinMilestone,
  getStartedQuests$,
  getStartedSummary$,
  setCheckinClaimedOpen$,
  rewardsNoteOpen$,
  setQuestIntroKey$,
  setRewardsNoteOpen$,
  setShareDialogOpen$,
  setSharePostDraft$,
  shareDialogOpen$,
  sharePostDraft$,
  submitSharePost$,
  shareSubmission$,
  setGetStartedMenuOpen$,
  type GetStartedQuest,
  type GetStartedSummary,
} from "../../signals/okou-page/get-started.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { formatLocalizedNumber } from "../../i18n/format.ts";
import { SlackMark } from "./components/slack-mark.tsx";
import {
  GetStartedCheckinDialog,
  GetStartedQuestIntroDialog,
  questHasIntro,
} from "./get-started-quest-intro-dialog.tsx";

// The ring is drawn at 16px so it agrees with the `[&_svg]:size-4` that Button
// enforces on its descendants, and its geometry is fixed at that size.
const RING_RADIUS = 7;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function QuestRing({ completed, total }: { completed: number; total: number }) {
  const fraction = completed / total;
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      strokeWidth={2}
      aria-hidden="true"
    >
      <circle cx={8} cy={8} r={RING_RADIUS} className="stroke-divider" />
      {fraction > 0 && (
        <circle
          cx={8}
          cy={8}
          r={RING_RADIUS}
          className="stroke-primary"
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  );
}

/** X publishes no icon font and lucide dropped brand marks, so it is inlined. */
function XMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4 shrink-0"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.53 3H21l-7.19 8.21L22.24 21h-6.63l-5.2-6.79L4.46 21H1l7.69-8.79L1.27 3h6.8l4.7 6.22L17.53 3Zm-1.16 16h1.83L7.75 4.9H5.79L16.37 19Z" />
    </svg>
  );
}

const QUEST_ICONS = Object.freeze<Record<GetStartedQuestKey, ReactNode>>({
  connector: <Link2 className="text-muted-foreground" />,
  slack: <SlackMark size={16} />,
  workflow: <Route className="text-muted-foreground" />,
  invite: <UserPlus className="text-muted-foreground" />,
  share: <XMark />,
  checkin: <CalendarCheck className="text-muted-foreground" />,
});

interface QuestCopy {
  readonly name: string;
  readonly description: string;
  /** The trailing unit on a reward that is paid more than once, if any. */
  readonly unit: string | null;
  /** The verb on the row's affordance, or null when the quest opens nothing. */
  readonly action: string | null;
}

function useQuestCopy(): Record<GetStartedQuestKey, QuestCopy> {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  return {
    connector: {
      name: t(($) => {
        return $.chat.agentPage.getStarted.connector.name;
      }),
      description: t(($) => {
        return $.chat.agentPage.getStarted.connector.description;
      }),
      unit: t(($) => {
        return $.chat.agentPage.getStarted.connector.unit;
      }),
      action: t(($) => {
        return $.chat.agentPage.getStarted.connector.action;
      }),
    },
    slack: {
      name: t(
        ($) => {
          return $.chat.agentPage.getStarted.slack.name;
        },
        { assistantName },
      ),
      description: t(($) => {
        return $.chat.agentPage.getStarted.slack.description;
      }),
      unit: null,
      action: t(($) => {
        return $.chat.agentPage.getStarted.slack.action;
      }),
    },
    workflow: {
      name: t(($) => {
        return $.chat.agentPage.getStarted.workflow.name;
      }),
      description: t(($) => {
        return $.chat.agentPage.getStarted.workflow.description;
      }),
      unit: null,
      action: t(($) => {
        return $.chat.agentPage.getStarted.workflow.action;
      }),
    },
    invite: {
      name: t(($) => {
        return $.chat.agentPage.getStarted.invite.name;
      }),
      description: t(($) => {
        return $.chat.agentPage.getStarted.invite.description;
      }),
      unit: t(($) => {
        return $.chat.agentPage.getStarted.invite.unit;
      }),
      action: t(($) => {
        return $.chat.agentPage.getStarted.invite.action;
      }),
    },
    share: {
      name: t(
        ($) => {
          return $.chat.agentPage.getStarted.share.name;
        },
        { assistantName },
      ),
      description: t(($) => {
        return $.chat.agentPage.getStarted.share.description;
      }),
      unit: null,
      action: t(($) => {
        return $.chat.agentPage.getStarted.share.action;
      }),
    },
    checkin: {
      name: t(($) => {
        return $.chat.agentPage.getStarted.checkin.name;
      }),
      description: t(($) => {
        return $.chat.agentPage.getStarted.checkin.description;
      }),
      unit: t(($) => {
        return $.chat.agentPage.getStarted.checkin.unit;
      }),
      action: t(($) => {
        return $.chat.agentPage.getStarted.checkin.action;
      }),
    },
  };
}

/**
 * What the quest pays, shown at the head of the row's second line.
 *
 * It led the trailing edge until the rows gained an affordance, and only one
 * of the two can sit there: a row that states its price where its button
 * belongs reads as a label rather than something to press. The amount keeps
 * the brand foreground so it still carries the row, and the unit stays muted
 * so the eye lands on the number.
 */
function QuestReward({
  amount,
  earned,
}: {
  amount: number;
  /** A banked reward is history, so it drops out of the brand foreground. */
  earned: boolean;
}) {
  return (
    <span
      className={`flex items-center gap-1 text-xs font-semibold tabular-nums ${
        earned ? "text-muted-foreground" : "text-brand-text"
      }`}
    >
      <Coins className="size-3 shrink-0" />+{formatLocalizedNumber(amount)}
    </span>
  );
}

/**
 * The row's action.
 *
 * The row itself is the menu item, so this is a span: a control nested inside
 * an option is invalid for the menu's roles. It borrows `buttonVariants` so the
 * two cannot drift, and every action is drawn at 76px -- "Check in" is the
 * widest label -- so the left edges line up with the right edges.
 */
function QuestAction({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className={buttonVariants({
        variant: "neutral",
        size: "xs",
        className: "pointer-events-none w-[76px] shrink-0 px-0",
      })}
    >
      {label}
    </span>
  );
}

// A quest row renders as a menu item, or as a plain div once nothing is left to
// open, so the row class has to carry the two rules `DropdownMenuItem` applies
// on its own: the menu's text size and the 16px icon. Without them a finished
// quest fell back to the document's 16px text and lucide's 24px default, which
// set the done rows a size above the rows beside them and pushed their titles
// 8px further right than the rest of the column.
// A 36px tile, the title column, and a 76px trailing slot. The tile is sized
// against the two-line text block beside it -- at 28 it sat 10px short of the
// block and read as floating.
const QUEST_ROW_CLASS =
  "grid grid-cols-[36px_minmax(0,1fr)_76px] items-center gap-3 px-3 py-2 text-sm [&_svg]:size-4 [&_svg]:shrink-0";

/**
 * The outcomes a reviewer can record, in the reader's words.
 *
 * `get-started-review.service.ts` writes a fixed set of reason codes; these are
 * the two a reader can act on. Anything else falls back to the plain "not
 * eligible", so a new code added on the server degrades rather than throws.
 */
function useRejectionCopy(): Record<string, string | undefined> {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  return {
    post_must_mention_okou: t(
      ($) => {
        return $.chat.agentPage.getStarted.rejected.postMustMention;
      },
      { assistantName },
    ),
    already_redeemed: t(($) => {
      return $.chat.agentPage.getStarted.rejected.alreadyRedeemed;
    }),
  };
}

/**
 * The state a row carries, as one muted fragment after a middot.
 *
 * The descriptions moved to the intro dialogs, so the second line went with
 * them; what is left is the part the dialog cannot know -- how far along this
 * user is. Facts, not prose.
 */
function useQuestState(
  quest: GetStartedQuest,
  /** Consecutive days, which only the check-in row states. */
  checkinStreak: number,
): string | null {
  const { t } = useTranslation();
  const rejection = useRejectionCopy();
  if (quest.status === "inReview") {
    return null;
  }
  if (quest.key === "checkin") {
    // The streak is the whole reason anyone comes back tomorrow, and it is the
    // one fact about this quest that neither its name nor its reward carries.
    return checkinStreak > 0
      ? t(
          ($) => {
            return $.chat.agentPage.getStarted.streak;
          },
          { amount: formatLocalizedNumber(checkinStreak) },
        )
      : null;
  }
  if (quest.status === "rejected") {
    // Saying only that it was turned down invites the same submission again,
    // so the row states the outcome the reviewer actually recorded.
    const stated =
      quest.rejectedReason === null
        ? undefined
        : rejection[quest.rejectedReason];
    return (
      stated ??
      t(($) => {
        return $.chat.agentPage.getStarted.notEligible;
      })
    );
  }
  if (quest.key === "invite" && quest.limit !== null) {
    const counts = `${formatLocalizedNumber(quest.claimedCount)}/${formatLocalizedNumber(quest.limit)}`;
    return quest.pendingCount > 0
      ? `${counts} · ${t(
          ($) => {
            return $.chat.agentPage.getStarted.pendingState;
          },
          { amount: formatLocalizedNumber(quest.pendingCount) },
        )}`
      : counts;
  }
  if (quest.key === "connector" && quest.claimedCount > 0) {
    return t(
      ($) => {
        return $.chat.agentPage.getStarted.addedState;
      },
      { amount: formatLocalizedNumber(quest.claimedCount) },
    );
  }
  return null;
}

function QuestRowBody({
  quest,
  copy,
  checkinStreak,
}: {
  quest: GetStartedQuest;
  copy: QuestCopy;
  checkinStreak: number;
}) {
  const { t } = useTranslation();
  const done = quest.status === "done" && !quest.canEarnMore;
  const actionable = quest.canEarnMore && quest.status !== "inReview";
  const state = useQuestState(quest, checkinStreak);
  // The check-in is the one quest whose name depends on its state: every other
  // row names a thing to do once, and this one is asked again tomorrow, so
  // once today is claimed it reports what happened instead of repeating the
  // instruction.
  const name =
    quest.key === "checkin" && done
      ? t(($) => {
          return $.chat.agentPage.getStarted.checkedIn;
        })
      : copy.name;
  return (
    <>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
        {QUEST_ICONS[quest.key]}
      </span>
      <span className="min-w-0">
        <span
          className={`block truncate ${done ? "text-muted-foreground" : ""}`}
        >
          {name}
        </span>
        {/* What it pays leads the second line; a finished quest keeps the
            figure, because the row is still worth what it earned. */}
        <span className="mt-0.5 flex min-w-0 items-center truncate text-xs">
          <QuestReward amount={quest.rewardAmount} earned={done} />
          {state !== null && (
            <span className="ml-1.5 truncate text-muted-foreground">
              · {state}
            </span>
          )}
        </span>
      </span>
      {/* One trailing slot, one meaning: finished, waiting, or pressable. */}
      <span className="flex items-center justify-end">
        {done && <Check className="shrink-0 text-chart-green" />}
        {quest.status === "inReview" && (
          <span className="text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.agentPage.getStarted.inReview;
            })}
          </span>
        )}
        {actionable && copy.action !== null && (
          <QuestAction label={copy.action} />
        )}
      </span>
    </>
  );
}

function QuestRow({
  quest,
  copy,
  onSelect,
  checkinStreak,
  opensModal = false,
  pending = false,
}: {
  quest: GetStartedQuest;
  copy: QuestCopy;
  onSelect: (() => void) | null;
  checkinStreak: number;
  /** Whether selecting the row opens a dialog rather than navigating. */
  opensModal?: boolean;
  pending?: boolean;
}) {
  const body = (
    <QuestRowBody quest={quest} copy={copy} checkinStreak={checkinStreak} />
  );
  const testId = `get-started-quest-${quest.key}`;

  // A quest with nothing left to open is a status line, not a control, so it
  // renders without a hover state rather than as a menu item that does nothing.
  if (onSelect === null) {
    return (
      <div className={QUEST_ROW_CLASS} data-testid={testId}>
        {body}
      </div>
    );
  }

  // A row that opens a dialog stays on the shared modal-item composition
  // path: a plain menu item closes the menu on click and takes the dialog it
  // just opened down with it.
  if (opensModal) {
    return (
      <DropdownMenuItem
        className={QUEST_ROW_CLASS}
        onClick={onSelect}
        data-testid={testId}
      >
        {body}
      </DropdownMenuItem>
    );
  }

  return (
    <DropdownMenuItem
      className={QUEST_ROW_CLASS}
      onClick={onSelect}
      closeOnClick={quest.key !== "checkin"}
      disabled={pending}
      aria-busy={pending}
      data-testid={testId}
    >
      {body}
    </DropdownMenuItem>
  );
}

function ShareOnXDialog() {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  const open = useGet(shareDialogOpen$);
  const postUrl = useGet(sharePostDraft$);
  const setOpen = useSet(setShareDialogOpen$);
  const setDraft = useSet(setSharePostDraft$);
  const submitShare = useSet(submitSharePost$);
  const pageSignal = useGet(pageSignal$);
  const submission = useLoadable(shareSubmission$);
  const submitting = submission.state === "loading";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent smMaxWidth="sm" maxWidth={420}>
        <DialogHeader>
          <DialogTitle>
            {t(
              ($) => {
                return $.chat.agentPage.getStarted.shareDialog.title;
              },
              { assistantName },
            )}
          </DialogTitle>
          <DialogDescription>
            {t(($) => {
              return $.chat.agentPage.getStarted.shareDialog.description;
            })}
          </DialogDescription>
        </DialogHeader>
        <div>
          <Input
            type="url"
            value={postUrl}
            aria-label={t(($) => {
              return $.chat.agentPage.getStarted.shareDialog.inputLabel;
            })}
            placeholder={t(($) => {
              return $.chat.agentPage.getStarted.shareDialog.placeholder;
            })}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {t(
              ($) => {
                return $.chat.agentPage.getStarted.shareDialog.helper;
              },
              { assistantName },
            )}
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setOpen(false);
            }}
          >
            {t(($) => {
              return $.chat.actions.cancel;
            })}
          </Button>
          <Button
            type="button"
            disabled={postUrl.trim() === "" || submitting}
            onClick={() => {
              detach(submitShare(pageSignal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.chat.agentPage.getStarted.shareDialog.submit;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Where a quest sends the user once they decide to do it.
 *
 * The intro dialog does not replace these; it runs the matching handoff on
 * confirm, so a quest has one destination whether or not it is introduced.
 */
function useQuestHandoffs(
  checkIn: (signal: AbortSignal) => Promise<number>,
  checkinReward: number,
): Record<GetStartedQuestKey, () => void> {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const openSettings = useSet(openSettingsDialogAt$);
  const navigate = useSet(detachedNavigateTo$);
  const setShareDialogOpen = useSet(setShareDialogOpen$);
  const setCheckinClaimedOpen = useSet(setCheckinClaimedOpen$);
  const introEnabled = useQuestIntroEnabled();
  return {
    connector: () => {
      navigate(ROUTES.connectors);
    },
    slack: () => {
      navigate(ROUTES.works);
    },
    workflow: () => {
      navigate(ROUTES.workflows);
    },
    invite: () => {
      detach(openSettings("people", pageSignal), Reason.DomCallback);
    },
    share: () => {
      setShareDialogOpen(true);
    },
    checkin: () => {
      detach(
        (async () => {
          const streak = await checkIn(pageSignal);
          if (!introEnabled) {
            return;
          }
          // The first day and every full week earn the screen; the days in
          // between earn a line. Both name the streak, which is the part that
          // brings someone back tomorrow.
          if (isCheckinMilestone(streak)) {
            setCheckinClaimedOpen(true);
            return;
          }
          toast.success(
            t(
              ($) => {
                return $.chat.agentPage.getStarted.streak;
              },
              { amount: formatLocalizedNumber(streak) },
            ),
            {
              description: t(
                ($) => {
                  return $.chat.agentPage.getStarted.intro.checkin.amount;
                },
                { amount: formatLocalizedNumber(checkinReward) },
              ),
            },
          );
        })(),
        Reason.DomCallback,
      );
    },
  };
}

function useQuestIntroEnabled(): boolean {
  return useGet(featureSwitch$)[FeatureSwitchKey.GetStartedQuestIntro] === true;
}

/**
 * What a row does when it is selected.
 *
 * With the intro switch on, a quest that has something to explain opens its
 * dialog first and the dialog performs the handoff; every other quest keeps
 * going straight to its destination.
 */
function useQuestActions(
  handoffs: Record<GetStartedQuestKey, () => void>,
): Record<GetStartedQuestKey, () => void> {
  const setQuestIntroKey = useSet(setQuestIntroKey$);
  const introEnabled = useQuestIntroEnabled();
  const actions: Partial<Record<GetStartedQuestKey, () => void>> = {};
  for (const key of Object.keys(handoffs) as GetStartedQuestKey[]) {
    actions[key] =
      introEnabled && questHasIntro(key)
        ? () => {
            setQuestIntroKey(key);
          }
        : handoffs[key];
  }
  return actions as Record<GetStartedQuestKey, () => void>;
}

/** The reward rules, unfolded in place rather than behind another surface. */
function RewardsNote() {
  const { t } = useTranslation();
  const open = useGet(rewardsNoteOpen$);
  const setOpen = useSet(setRewardsNoteOpen$);
  return (
    <div className="mt-2">
      <button
        type="button"
        className="flex w-full items-center gap-1 rounded-lg px-3 pb-2.5 pt-2 text-left text-xs text-muted-foreground transition-colors hover:bg-state-hover [&_svg]:size-3 [&_svg]:shrink-0"
        onClick={() => {
          setOpen(!open);
        }}
        aria-expanded={open}
      >
        <span>
          {t(($) => {
            return $.chat.agentPage.getStarted.howRewardsWork;
          })}
        </span>
        <ChevronRight
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <p className="px-3 pb-1 text-xs leading-[1.5] text-muted-foreground">
          {t(($) => {
            return $.chat.agentPage.getStarted.rewardsNote;
          })}
        </p>
      )}
    </div>
  );
}

function GetStartedPanel({
  quests,
  summary,
  handoffs,
  checkinPending,
}: {
  quests: readonly GetStartedQuest[];
  summary: GetStartedSummary;
  handoffs: Record<GetStartedQuestKey, () => void>;
  checkinPending: boolean;
}) {
  const { t } = useTranslation();
  const copy = useQuestCopy();
  const actions = useQuestActions(handoffs);
  const introEnabled = useQuestIntroEnabled();
  const opensModal = (quest: GetStartedQuest): boolean => {
    return quest.key === "share" || (introEnabled && questHasIntro(quest.key));
  };
  // The check-in leads whatever its state, because it is asked again tomorrow:
  // a daily row that changes place with the day would have to be found again
  // every morning. Behind it, finished work sinks to the bottom, so what is
  // still claimable leads the rest of the list.
  const orderedQuests = [...quests].sort((left, right) => {
    const rank = (quest: GetStartedQuest): number => {
      if (quest.key === "checkin") {
        return 0;
      }
      return quest.status === "done" && !quest.canEarnMore ? 2 : 1;
    };
    return rank(left) - rank(right);
  });
  const selectHandler = (quest: GetStartedQuest): (() => void) | null => {
    return quest.canEarnMore && quest.status !== "inReview"
      ? actions[quest.key]
      : null;
  };

  // 420px with a 16px outer radius and an 8px tray. The totals are the panel
  // talking about the whole list rather than about any one quest, so they take
  // a header line on the tray and leave every row on one grid: one tile
  // column, one title column, one 76px trailing slot, one content edge.
  return (
    <DropdownMenuContent align="end" className="w-[420px] rounded-[16px] p-2">
      <div className="flex items-baseline justify-between gap-3 px-3 pb-2 pt-1.5">
        <p className="min-w-0 truncate text-[13px] font-semibold tabular-nums">
          {t(
            ($) => {
              return $.chat.agentPage.getStarted.toGo;
            },
            { amount: formatLocalizedNumber(summary.remainingCredits) },
          )}
        </p>
        <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {t(
            ($) => {
              return $.chat.agentPage.getStarted.earned;
            },
            { amount: formatLocalizedNumber(summary.earnedCredits) },
          )}
        </p>
      </div>
      <div>
        {orderedQuests.map((quest) => {
          return (
            <QuestRow
              key={quest.key}
              quest={quest}
              copy={copy[quest.key]}
              onSelect={selectHandler(quest)}
              checkinStreak={summary.checkinStreak}
              opensModal={opensModal(quest)}
              pending={quest.key === "checkin" && checkinPending}
            />
          );
        })}
      </div>
      <RewardsNote />
    </DropdownMenuContent>
  );
}

/**
 * The home corner's onboarding entry.
 *
 * It takes the same shape as the growth control beside it — 32px tall, the same
 * 12px radius, hairline and card shadow — so the two read as one row rather
 * than as a control and a banner. The ring is the only mark the corner gains.
 */
export function GetStartedEntry() {
  const { t } = useTranslation();
  const questsLoadable = useLastLoadable(getStartedQuests$);
  const summaryLoadable = useLastLoadable(getStartedSummary$);
  const setMenuOpen = useSet(setGetStartedMenuOpen$);
  // The dialogs outlive the dropdown that opened them, so the handoffs they
  // run are built here rather than inside the panel's own tree.
  const [checkinLoadable, checkIn] = useLoadableSet(checkInGetStarted$);
  // Read before the loading guard below, because the handoffs are hooks and
  // cannot be built conditionally. Zero until the quests land, which is also
  // when the entry renders nothing at all.
  const checkinReward =
    questsLoadable.state === "hasData"
      ? (questsLoadable.data.find((quest) => {
          return quest.key === "checkin";
        })?.rewardAmount ?? 0)
      : 0;
  const handoffs = useQuestHandoffs(checkIn, checkinReward);

  if (
    questsLoadable.state !== "hasData" ||
    summaryLoadable.state !== "hasData"
  ) {
    return null;
  }
  const summary = summaryLoadable.data;
  if (summary.total === 0) {
    return null;
  }
  const checkinQuest = questsLoadable.data.find((quest) => {
    return quest.key === "checkin";
  });

  return (
    <>
      <DropdownMenu onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="quiet"
              size="sm"
              className="h-8 gap-2 rounded-surface-compact border border-surface-border bg-card px-[11px] text-foreground shadow-surface data-popup-open:bg-state-hover"
              data-testid="get-started-entry"
            />
          }
        >
          <QuestRing completed={summary.completed} total={summary.total} />
          <span className="text-[13px] font-medium">
            {t(($) => {
              return $.chat.agentPage.getStarted.title;
            })}
          </span>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-divider" />
          <span className="text-xs font-semibold tabular-nums text-muted-foreground">
            {t(
              ($) => {
                return $.chat.agentPage.getStarted.stepCount;
              },
              { completed: summary.completed, total: summary.total },
            )}
          </span>
        </DropdownMenuTrigger>
        <GetStartedPanel
          quests={questsLoadable.data}
          summary={summary}
          handoffs={handoffs}
          checkinPending={checkinLoadable.state === "loading"}
        />
      </DropdownMenu>
      <ShareOnXDialog />
      <GetStartedQuestIntroDialog
        onConfirm={(key) => {
          handoffs[key]();
        }}
      />
      {/* The quest the dialog reports on is the one the panel just checked in,
          so the dialog exists exactly when that quest does. */}
      {checkinQuest && (
        <GetStartedCheckinDialog
          reward={checkinQuest.rewardAmount}
          streak={summary.checkinStreak}
        />
      )}
    </>
  );
}
