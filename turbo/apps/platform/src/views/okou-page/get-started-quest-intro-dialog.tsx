import type { GetStartedQuestKey } from "@okouai/api-contracts/contracts/get-started";
import type { ReactNode } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
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
 * The quest drawings, from the Brand assets library.
 *
 * These replace five figures that were assembled here out of divs -- a replica
 * of Slack's message list, tile pairs joined by dots, a fake report table. That
 * approach put eight off-scale spacings, two off-ladder radii and four type
 * sizes into this file that exist nowhere else in the product, and it produced
 * art that could not be art-directed. The library is drawn by the people who
 * own the brand; the product's job is to frame it.
 *
 * Exported as the artboard group rather than the frame, so each file is
 * transparent and sits on whatever paper the product gives it. Every name
 * carries its own content hash, and `static.okou.io` hard caches for a year,
 * so a re-export lands on a new path instead of serving stale.
 */
const QUEST_ART = Object.freeze({
  slack: "get-started-slack-12b969d9d2a7.png",
  invite: "get-started-invite-09ddee851551.png",
  workflow: "get-started-workflow-6e3bfc12345c.png",
  prompt: "get-started-prompt-39ad0cd9e05f.png",
  checkinWeek: "get-started-checkin-week-b218eb5cd860.png",
});

function questArtUrl(name: keyof typeof QUEST_ART): string {
  return platformStaticAssetUrl(`views/okou-page/assets/${QUEST_ART[name]}`);
}

/**
 * The panel a quest drawing is printed on.
 *
 * One fixed-width column, full bleed to the card's own edge, with the drawing
 * centred in it. The paper is the same value in both themes: it is the sheet
 * the drawing is printed on rather than a UI surface, the argument the style
 * guide already makes for illustration stroke weights -- and it is what lets
 * one asset serve Light and Dark instead of needing a second drawing.
 *
 * The drawing is capped in both directions, not just width. Capping width alone
 * let a portrait drawing set the panel's height from its own aspect ratio: the
 * gears landed at 280x317 and took 57% of the dialog while the landscape art
 * took 43%, so the same shell changed shape depending on which file it got.
 * With both capped the column is a constant and the words decide the height.
 */
const FIGURE_W = 248;
const ART_MAX = 188;

function QuestFigure({ art }: { art: keyof typeof QUEST_ART }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center bg-illustration-canvas p-5"
      style={{ width: FIGURE_W }}
    >
      <img
        src={questArtUrl(art)}
        alt=""
        aria-hidden
        className="block w-full object-contain"
        style={{ maxHeight: ART_MAX }}
      />
    </div>
  );
}

/**
 * One of the three steps.
 *
 * The order is carried by a number, which is what a number is for. The tiles
 * this replaces drew three accents from the start-card palette, where each
 * colour stands for a different *kind* of work -- so three consecutive steps of
 * one process read as three unrelated categories.
 */
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
    <div className="flex items-start gap-3 py-1.5">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-brand-subtle text-xs font-semibold tabular-nums text-brand-text">
        {formatLocalizedNumber(index)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">
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
    <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
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
  const body = (
    <>
      <DialogHeader>
        {/* The close button is absolutely placed at the top right, so a title
            long enough to wrap runs underneath it without this inset. */}
        <DialogTitle className="pr-7">{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      {/* The price is its own row rather than trailing the description: in a
          column this narrow a chip sharing that line pushes the sentence into
          an extra wrap. The title is the argument and the price is a fact
          about it, so it sits directly under both.

          The width has to be the chip's own, because this row lands in two
          different formatting contexts: the flex column below, and the shell's
          `grid gap-4 p-6` for a step that keeps the plain padded body. A grid
          item is blockified and stretched by the initial `justify-self`, so an
          alignment utility alone left the chip spanning the whole column. */}
      {reward !== undefined && (
        <Badge className="w-fit text-xs font-semibold tabular-nums text-brand-text">
          <Coins />+{formatLocalizedNumber(reward)}
        </Badge>
      )}
      {children}
      <DialogFooter className="mt-auto">
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

  /*
   * A step whose body is already structured -- the connector catalog -- keeps
   * the plain padded shell. Only a step whose argument is otherwise just prose
   * earns the drawing, and then the dialog becomes two panels.
   */
  if (figure === undefined) {
    return body;
  }

  /*
   * The drawing takes a column and the words take the rest.
   *
   * Spanning the header across both panels is what left the earlier version
   * hollow: the picture had nothing beside it at the top and the prose had
   * nothing to sit under, so three lines floated in the middle of the column
   * with unowned white above and below. With the whole text block inside the
   * column, every edge of both panels is doing something.
   *
   * `-m-6` cancels the body's own padding so the drawing reaches its own edge.
   * An inset tile reads as a thumbnail pasted on; a panel reads as part of the
   * card.
   */
  return (
    <div className="-m-6 flex items-stretch">
      {figure}
      <div className="flex min-w-0 flex-1 flex-col gap-3 p-6">{body}</div>
    </div>
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
      reward={reward}
      secondaryLabel={useLaterLabel()}
      onSecondary={onClose}
      confirmLabel={t(($) => {
        return $.chat.agentPage.getStarted.intro.connector.confirm;
      })}
      onConfirm={onConfirm}
    >
      {/* The connectors themselves are the illustration: every one of them
          connects in one press, which is the claim the abstract figure was
          making and these marks make better. They are body content rather than
          the figure slot, because that slot is now a full-bleed band above the
          header -- a scrolling grid does not belong there. */}
      <QuestConnectorPicker onNeedsChoice={onNeedsChoice} />
    </IntroLayout>
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
      figure={<QuestFigure art="slack" />}
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
      figure={<QuestFigure art="invite" />}
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
      figure={<QuestFigure art="workflow" />}
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
      figure={<QuestFigure art="prompt" />}
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
          // One width for every quest modal. The split layout holds the
          // drawing in its own column, so a wide shell no longer leaves a
          // centred illustration swimming -- which was the only reason the
          // illustrated steps were narrower than the catalog in the first
          // place.
          smMaxWidth={680}
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
export function GetStartedCheckinDialog({
  reward,
  streak,
}: {
  reward: number;
  /** Consecutive days, named here because it is the reason to come back. */
  streak: number;
}) {
  const { t } = useTranslation();
  const open = useGet(checkinClaimedOpen$);
  const setOpen = useSet(setCheckinClaimedOpen$);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent smMaxWidth={680}>
        {/* The milestone joins the same two panels as every other quest
            screen. It keeps the one thing a reward screen needs that a step
            screen does not -- the amount at display size -- but it stops
            being the one dialog in the flow with its own shape. */}
        <div className="-m-6 flex items-stretch">
          <QuestFigure art="checkinWeek" />
          <div className="flex min-w-0 flex-1 flex-col gap-3 p-6">
            <DialogHeader>
              <DialogTitle className="pr-7">
                {t(($) => {
                  return $.chat.agentPage.getStarted.intro.checkin.title;
                })}
              </DialogTitle>
              {/* The streak, not the amount, is what brings someone back
                  tomorrow, and the screen never said it. It reads as the
                  subtitle but it is not the dialog's description: a milestone
                  at streak 0 is reachable, and the slot that names the screen
                  has to be the line that is always there. */}
              {streak > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t(
                    ($) => {
                      return $.chat.agentPage.getStarted.streak;
                    },
                    { amount: formatLocalizedNumber(streak) },
                  )}
                </p>
              )}
            </DialogHeader>
            <p className="text-2xl font-semibold tabular-nums tracking-tight text-brand-text">
              {t(
                ($) => {
                  return $.chat.agentPage.getStarted.intro.checkin.amount;
                },
                { amount: formatLocalizedNumber(reward) },
              )}
            </p>
            {/* The component rather than a hand-written paragraph, so this
                screen's body prose takes the same leading as the other six
                instead of its own. */}
            <DialogDescription>
              {t(($) => {
                return $.chat.agentPage.getStarted.intro.checkin.description;
              })}
            </DialogDescription>
            <DialogFooter className="mt-auto">
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
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
