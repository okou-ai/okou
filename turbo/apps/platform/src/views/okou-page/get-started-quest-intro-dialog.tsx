import type { GetStartedQuestKey } from "@okouai/api-contracts/contracts/get-started";
import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Play } from "lucide-react";
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
import { SlackMark } from "./components/slack-mark.tsx";
import { platformStaticAssetUrl } from "../../lib/static-assets.ts";
import {
  BAND_ALPHA,
  FILL_ALPHA,
  ILLUSTRATION_ACCENTS,
  LINE_ALPHA,
  NODE_CLASS,
  SOFT_ALPHA,
  THUMBNAIL_CLASS,
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
 * The illustrated tile the product already uses on its start cards: one washed
 * square per idea, drawn from the avatar palette, with the art built out of
 * bordered card nodes rather than flat glyphs. A quest is introduced with a row
 * of these so the dialog reads as the same family as the page behind it.
 */
function Tile({ accent, children }: { accent: string; children: ReactNode }) {
  return (
    <div
      className={THUMBNAIL_CLASS}
      style={{ backgroundColor: `${accent}${TILE_ALPHA}` }}
    >
      {children}
    </div>
  );
}

/**
 * The illustration gets its own ground rather than floating on the dialog's
 * paper: a washed band reads as one picture, and it separates the drawing from
 * the sentences under it without a rule.
 */
function TileRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-3 rounded-xl bg-state-hover px-4 py-5">
      {children}
    </div>
  );
}

/** The join between two tiles: what the quest actually adds. */
function Link({ accent }: { accent: string }) {
  return (
    <span className="flex shrink-0 items-center gap-[3px]">
      {["a", "b", "c"].map((id) => {
        return (
          <span
            key={id}
            className="size-[3px] rounded-full"
            style={{ backgroundColor: `${accent}${SOFT_ALPHA}` }}
          />
        );
      })}
    </span>
  );
}

/** A stack of lines standing in for a document, message or row. */
function Lines({
  accent,
  width,
  count = 2,
  height = 3,
}: {
  accent: string;
  width: number;
  count?: number;
  height?: number;
}) {
  return (
    <span className="flex flex-col gap-[4px]">
      {/* The last line is short, the way a paragraph ends. */}
      {Array.from({ length: count }, (_, index) => {
        return {
          id: `line-${index}`,
          width: index === count - 1 ? width * 0.62 : width,
        };
      }).map(({ id, width: lineWidth }) => {
        return (
          <span
            key={id}
            className="rounded-full"
            style={{
              width: lineWidth,
              height,
              backgroundColor: `${accent}${SOFT_ALPHA}`,
            }}
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

/** A bust: the account glyph, reused wherever a person is meant. */
function Person({ accent, size }: { accent: string; size: number }) {
  return (
    <span
      className="relative shrink-0 overflow-hidden rounded-full border bg-card"
      style={{
        width: size,
        height: size,
        borderColor: `${accent}${LINE_ALPHA}`,
      }}
    >
      <span
        className="absolute left-1/2 rounded-full"
        style={{
          top: size * 0.24,
          width: size * 0.28,
          height: size * 0.28,
          marginLeft: -size * 0.14,
          backgroundColor: `${accent}${FILL_ALPHA}`,
        }}
      />
      <span
        className="absolute bottom-0 left-1/2 rounded-t-full"
        style={{
          width: size * 0.58,
          height: size * 0.32,
          marginLeft: -size * 0.29,
          backgroundColor: `${accent}${FILL_ALPHA}`,
        }}
      />
    </span>
  );
}

/**
 * What a connector adds: Okou on one side, the user's own mail, docs and
 * calendar on the other. Two shapes and a join — the sentence underneath does
 * the explaining, so the picture only has to be legible at a glance.
 */
function ConnectorFigure() {
  const accent = ILLUSTRATION_ACCENTS.website;
  return (
    <TileRow>
      <Tile accent={accent}>
        <OkouAvatar size={46} />
      </Tile>
      <Link accent={accent} />
      <Tile accent={accent}>
        <span className="flex flex-col gap-[5px]">
          {["mail", "doc"].map((id) => {
            return (
              <span
                key={id}
                className={`flex h-[21px] w-[48px] items-center gap-[5px] px-[5px] ${NODE_CLASS}`}
                style={{ borderColor: `${accent}${LINE_ALPHA}` }}
              >
                <span
                  className="size-[9px] shrink-0 rounded-[2px]"
                  style={{ backgroundColor: `${accent}${FILL_ALPHA}` }}
                />
                <Lines accent={accent} width={24} count={2} height={2} />
              </span>
            );
          })}
        </span>
      </Tile>
    </TileRow>
  );
}

/**
 * The channel, after the quest is done: Okou answering in it.
 *
 * One card, four elements. An earlier draft drew the whole Slack window —
 * rail, someone asking, the reply and its result — and at this size that read
 * as texture rather than as a picture. What has to be recognised is the
 * channel and who is talking in it.
 */
function SlackFigure({ assistantName }: { assistantName: string }) {
  const { t } = useTranslation();
  // Slack's own aubergine, so the card is recognised before it is read.
  const accent = "#4A154B";
  const mention = `@${assistantName.toLowerCase()}`;
  return (
    <TileRow>
      <span
        className={`w-[264px] overflow-hidden ${NODE_CLASS}`}
        style={{ borderColor: `${accent}${LINE_ALPHA}` }}
      >
        {/* A hairline, not a filled bar: the channel name is the only thing
            that has to carry this row, and text reads as a channel where a
            grey band reads as something still loading. */}
        <span
          className="flex items-center gap-[6px] border-b px-[12px] py-[9px]"
          style={{ borderColor: `${accent}${LINE_ALPHA}` }}
        >
          <SlackMark size={13} />
          <span
            className="text-[11px] font-semibold leading-none"
            style={{ color: accent }}
          >
            {t(($) => {
              return $.chat.agentPage.getStarted.intro.slack.sampleChannel;
            })}
          </span>
        </span>
        <span className="flex items-start gap-[9px] px-[12px] py-[11px]">
          <OkouAvatar size={30} />
          <span className="flex flex-col gap-[6px] pt-[1px]">
            <span className="flex items-center gap-[6px]">
              <span className="text-[11px] font-semibold leading-none">
                {assistantName}
              </span>
              <span
                className="rounded-[3px] px-[5px] py-[2px] text-[9px] font-semibold leading-none"
                style={{
                  backgroundColor: `${accent}${BAND_ALPHA}`,
                  color: accent,
                }}
              >
                {mention}
              </span>
            </span>
            <Lines accent={accent} width={150} count={2} height={4} />
          </span>
        </span>
      </span>
    </TileRow>
  );
}

/** One saved workflow, handed to everyone who joins. */
function InviteFigure() {
  const accent = ILLUSTRATION_ACCENTS.illustration;
  return (
    <TileRow>
      <Tile accent={accent}>
        <span
          className={`flex h-[46px] w-[50px] flex-col gap-[6px] p-[7px] ${NODE_CLASS}`}
          style={{ borderColor: `${accent}${LINE_ALPHA}` }}
        >
          <span
            className="h-[5px] w-[24px] rounded-full"
            style={{ backgroundColor: `${accent}${FILL_ALPHA}` }}
          />
          <Lines accent={accent} width={36} count={2} height={3} />
        </span>
      </Tile>
      <Link accent={accent} />
      <Tile accent={accent}>
        {/* Overlapped, the way a team reads in every product's member list. */}
        <span className="flex items-center">
          {["a", "b", "c"].map((id, index) => {
            return (
              <span
                key={id}
                // A ring of paper between the busts; overlapped without it,
                // three of them read as one shape.
                style={{ marginLeft: index === 0 ? 0 : -7 }}
                className="rounded-full bg-card p-[2px]"
              >
                <Person accent={accent} size={24} />
              </span>
            );
          })}
        </span>
      </Tile>
    </TileRow>
  );
}

/** Step 1: a list of ready-made workflows with one of them chosen. */
function TemplateArt({ accent }: { accent: string }) {
  return (
    <span className="flex flex-col gap-[3px]">
      {[
        { id: "above", chosen: false },
        { id: "chosen", chosen: true },
        { id: "below", chosen: false },
      ].map(({ id, chosen }) => {
        return (
          <span
            key={id}
            className={`flex h-[13px] w-[44px] items-center gap-[4px] px-[4px] ${NODE_CLASS}`}
            style={{
              borderColor: chosen ? accent : `${accent}${LINE_ALPHA}`,
              backgroundColor: chosen ? `${accent}${BAND_ALPHA}` : undefined,
            }}
          >
            <span
              className="size-[5px] shrink-0 rounded-[1px]"
              style={{
                backgroundColor: chosen ? accent : `${accent}${SOFT_ALPHA}`,
              }}
            />
            <span
              className="h-[2px] rounded-full"
              style={{
                width: 24,
                backgroundColor: chosen ? accent : `${accent}${SOFT_ALPHA}`,
              }}
            />
          </span>
        );
      })}
    </span>
  );
}

/** Step 2: it runs, and the result is already there. */
function RunArt({ accent }: { accent: string }) {
  return (
    <span
      className={`flex h-[42px] w-[48px] flex-col justify-center gap-[5px] px-[6px] ${NODE_CLASS}`}
      style={{ borderColor: `${accent}${LINE_ALPHA}` }}
    >
      <span className="flex items-center gap-[4px]">
        <span
          className="grid size-[12px] place-items-center rounded-full"
          style={{ backgroundColor: `${accent}${SOFT_ALPHA}`, color: accent }}
        >
          <Play size={6} fill="currentColor" />
        </span>
        <Lines accent={accent} width={20} count={1} />
      </span>
      <span
        className="h-[12px] rounded-[2px]"
        style={{ backgroundColor: `${accent}${FILL_ALPHA}` }}
      />
    </span>
  );
}

/** Step 3: saved, and from then on it keeps its own time. */
function SaveArt({ accent }: { accent: string }) {
  return (
    <span
      className={`grid h-[42px] w-[48px] place-items-center ${NODE_CLASS}`}
      style={{ borderColor: `${accent}${LINE_ALPHA}` }}
    >
      <span
        className="relative grid size-[24px] place-items-center rounded-full border"
        style={{ borderColor: `${accent}${LINE_ALPHA}` }}
      >
        <span
          className="absolute left-1/2 top-1/2 h-[7px] w-[2px] origin-bottom rounded-full"
          style={{
            backgroundColor: accent,
            transform: "translate(-50%,-100%)",
          }}
        />
        <span
          className="absolute left-1/2 top-1/2 h-[2px] w-[6px] origin-left rounded-full"
          style={{ backgroundColor: accent, transform: "translateY(-50%)" }}
        />
      </span>
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
      figure={<SlackFigure assistantName={assistantName} />}
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
            <Tile accent={ILLUSTRATION_ACCENTS.illustration}>
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
            <Tile accent={ILLUSTRATION_ACCENTS.website}>
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
            <Tile accent={ILLUSTRATION_ACCENTS.slides}>
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
