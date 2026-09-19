import type { GetStartedQuestKey } from "@okouai/api-contracts/contracts/get-started";
import type { ReactNode } from "react";
import { useGet, useLastLoadable, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  CalendarCheck,
  Check,
  Coins,
  Link2,
  UserPlus,
  Workflow,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@okouai/ui";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { assistantName$ } from "../../signals/branding.ts";
import { detachedNavigateTo$ } from "../../signals/route.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { openSettingsDialogAt$ } from "../../signals/okou-page/settings/settings-dialog.ts";
import {
  checkInGetStarted$,
  getStartedQuests$,
  getStartedSummary$,
  setCheckinClaimedOpen$,
  setQuestIntroKey$,
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
import { DropdownMenuModalItem } from "../components/dropdown-menu-modal-item.tsx";
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
  workflow: <Workflow className="text-muted-foreground" />,
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
  unit,
}: {
  amount: number;
  unit: string | null;
}) {
  const { t } = useTranslation();
  return (
    <span className="font-semibold tabular-nums text-brand-text">
      {t(
        ($) => {
          return $.chat.agentPage.getStarted.reward;
        },
        { amount: formatLocalizedNumber(amount) },
      )}
      {unit !== null && (
        <span className="font-normal text-muted-foreground"> {unit}</span>
      )}
    </span>
  );
}

/**
 * The row's press affordance.
 *
 * The row itself is the menu item, so this is a span: a control nested inside
 * an option is invalid for the menu's roles, and the row already owns the
 * click, the hover state and the keyboard focus. It borrows `buttonVariants`
 * rather than restating a button's geometry, so the two cannot drift, and it
 * is hidden from assistive technology because the row's own name already says
 * what activating it does.
 */
function QuestAction({ label }: { label: string }) {
  return (
    <span
      aria-hidden="true"
      className={buttonVariants({
        variant: "neutral",
        size: "xs",
        className: "pointer-events-none shrink-0",
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
const QUEST_ROW_CLASS =
  "gap-3 px-3 py-2.5 text-sm [&_svg]:size-4 [&_svg]:shrink-0";

function QuestRowBody({
  quest,
  copy,
  actionable,
}: {
  quest: GetStartedQuest;
  copy: QuestCopy;
  /** Whether the row opens something, so it earns a press affordance. */
  actionable: boolean;
}) {
  const { t } = useTranslation();
  const done = quest.status === "done" && !quest.canEarnMore;
  const earning = quest.canEarnMore && quest.status !== "inReview";
  const description =
    quest.status === "inReview"
      ? t(($) => {
          return $.chat.agentPage.getStarted.inReviewDescription;
        })
      : quest.status === "rejected"
        ? t(($) => {
            return $.chat.agentPage.getStarted.rejectedDescription;
          })
        : copy.description;
  return (
    <>
      {QUEST_ICONS[quest.key]}
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate ${done ? "text-muted-foreground" : ""}`}
        >
          {copy.name}
        </span>
        <span className="block text-xs text-muted-foreground">
          {earning && (
            <>
              <QuestReward amount={quest.rewardAmount} unit={copy.unit} />
              {" · "}
            </>
          )}
          {description}
        </span>
        {quest.key === "invite" && quest.limit !== null && (
          <span className="block text-xs text-muted-foreground">
            {formatLocalizedNumber(quest.claimedCount)}/
            {formatLocalizedNumber(quest.limit)}
            {quest.pendingCount > 0 && (
              <>
                {" "}
                ·{" "}
                {t(
                  ($) => {
                    return $.chat.agentPage.getStarted.pendingInvitations;
                  },
                  {
                    amount: formatLocalizedNumber(quest.pendingCount),
                  },
                )}
              </>
            )}
          </span>
        )}
        {quest.key === "connector" && quest.claimedCount > 0 && (
          <span className="block text-xs text-muted-foreground">
            {t(
              ($) => {
                return $.chat.agentPage.getStarted.rewardedConnections;
              },
              {
                amount: formatLocalizedNumber(quest.claimedCount),
              },
            )}
          </span>
        )}
      </span>
      {/* One trailing slot, one meaning: finished, waiting, or pressable. */}
      {done && <Check className="shrink-0 text-[#2EB67D]" />}
      {quest.status === "inReview" && (
        <span className="shrink-0 rounded-full bg-gray-50 px-2 py-0.5 text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.agentPage.getStarted.inReview;
          })}
        </span>
      )}
      {actionable && copy.action !== null && (
        <QuestAction label={copy.action} />
      )}
    </>
  );
}

function QuestRow({
  quest,
  copy,
  onSelect,
  opensModal = false,
  pending = false,
}: {
  quest: GetStartedQuest;
  copy: QuestCopy;
  onSelect: (() => void) | null;
  /** Whether selecting the row opens a dialog rather than navigating. */
  opensModal?: boolean;
  pending?: boolean;
}) {
  const body = (
    <QuestRowBody quest={quest} copy={copy} actionable={onSelect !== null} />
  );
  const testId = `get-started-quest-${quest.key}`;

  // A quest with nothing left to open is a status line, not a control, so it
  // renders without a hover state rather than as a menu item that does nothing.
  if (onSelect === null) {
    return (
      <div
        className={`flex items-center ${QUEST_ROW_CLASS}`}
        data-testid={testId}
      >
        {body}
      </div>
    );
  }

  // A row that opens a dialog stays on the shared modal-item composition
  // path: a plain menu item closes the menu on click and takes the dialog it
  // just opened down with it.
  if (opensModal) {
    return (
      <DropdownMenuModalItem
        className={QUEST_ROW_CLASS}
        onModalSelect={onSelect}
        data-testid={testId}
      >
        {body}
      </DropdownMenuModalItem>
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
  checkIn: (signal: AbortSignal) => Promise<void>,
): Record<GetStartedQuestKey, () => void> {
  const pageSignal = useGet(pageSignal$);
  const openSettings = useSet(openSettingsDialogAt$);
  const navigate = useSet(detachedNavigateTo$);
  const setShareDialogOpen = useSet(setShareDialogOpen$);
  const setCheckinClaimedOpen = useSet(setCheckinClaimedOpen$);
  const introEnabled = useQuestIntroEnabled();
  return {
    connector: () => {
      navigate("/connectors");
    },
    slack: () => {
      navigate("/works");
    },
    workflow: () => {
      navigate("/workflows");
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
          await checkIn(pageSignal);
          if (introEnabled) {
            setCheckinClaimedOpen(true);
          }
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
  const percent = (summary.completed / summary.total) * 100;
  // Keep the daily reward separate from the other quests.
  const setupQuests = quests.filter((quest) => {
    return quest.key !== "checkin";
  });
  const dailyQuests = quests.filter((quest) => {
    return quest.key === "checkin";
  });
  const selectHandler = (quest: GetStartedQuest): (() => void) | null => {
    return quest.canEarnMore && quest.status !== "inReview"
      ? actions[quest.key]
      : null;
  };

  // 400px, not 356: the rows gave their trailing edge to an affordance, so the
  // text column buys that width back rather than wrapping to pay for it.
  return (
    <DropdownMenuContent align="end" className="w-[400px]">
      <div className="flex items-start gap-2.5 px-3 pb-2 pt-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold">
            {t(($) => {
              return $.chat.agentPage.getStarted.title;
            })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(($) => {
              return $.chat.agentPage.getStarted.subtitle;
            })}
          </p>
        </div>
        <span className="flex h-[22px] shrink-0 items-center gap-1.5 rounded-full bg-brand-subtle px-2 text-xs font-semibold tabular-nums text-brand-text">
          {/* A pill enforces no icon size the way Button and DropdownMenuItem
              do, so the mark is sized against this one: 12px is what Badge
              gives an icon in a pill, and lucide's 24px default overflowed the
              22px box. */}
          <Coins className="size-3 shrink-0" />
          {formatLocalizedNumber(summary.earnedCredits)}
        </span>
      </div>
      <div className="px-3 pb-2.5">
        <span
          role="progressbar"
          aria-label={t(($) => {
            return $.chat.agentPage.getStarted.progressLabel;
          })}
          aria-valuemin={0}
          aria-valuemax={summary.total}
          aria-valuenow={summary.completed}
          className="block h-1 overflow-hidden rounded-full bg-divider"
        >
          <span
            className="block h-full rounded-full bg-primary"
            style={{ width: `${percent}%` }}
          />
        </span>
      </div>
      <DropdownMenuSeparator />
      {setupQuests.map((quest) => {
        return (
          <QuestRow
            key={quest.key}
            quest={quest}
            copy={copy[quest.key]}
            onSelect={selectHandler(quest)}
            opensModal={opensModal(quest)}
          />
        );
      })}
      {dailyQuests.length > 0 && <DropdownMenuSeparator />}
      {dailyQuests.map((quest) => {
        return (
          <QuestRow
            key={quest.key}
            quest={quest}
            copy={copy[quest.key]}
            onSelect={selectHandler(quest)}
            pending={checkinPending}
          />
        );
      })}
      <DropdownMenuSeparator />
      <p className="px-3 pb-1 pt-1.5 text-xs text-muted-foreground">
        {t(($) => {
          return $.chat.agentPage.getStarted.personalBalanceNote;
        })}
      </p>
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
  const handoffs = useQuestHandoffs(checkIn);

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
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="quiet"
            size="sm"
            className="h-8 gap-2 rounded-surface-compact border border-surface-border bg-card px-[11px] text-foreground shadow-surface data-popup-open:bg-state-hover"
            data-testid="get-started-entry"
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
          </Button>
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
        <GetStartedCheckinDialog reward={checkinQuest.rewardAmount} />
      )}
    </>
  );
}
