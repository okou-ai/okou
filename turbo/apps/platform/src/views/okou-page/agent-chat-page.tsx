import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { user$ } from "../../signals/auth.ts";
import { Pin } from "lucide-react";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import {
  currentChatAgentId$,
  currentChatAgentDisplayName$,
} from "../../signals/agent-chat.ts";
import {
  setAgentPinned$,
  currentChatAgentPinned$,
} from "../../signals/okou-page/pinned-agents.ts";

import { detach, Reason } from "../../signals/utils.ts";
import { ChatComposer } from "./chat-composer.tsx";
import { StartCards } from "./start-cards.tsx";
import { ComposerTaskChips } from "./composer-task-chips.tsx";
import { GrowthEntryHeader } from "./growth-entry.tsx";
import {
  chatPageTaglineDisplayed$,
  chatPageTaglineIndex$,
  chatPageTaglineStarted$,
  chatPageTaglineTypewriterRef$,
} from "../../signals/okou-page/chat-page.ts";
import { agentChatComposerSignals$ } from "../../signals/okou-page/agent-composer-signals.ts";
import { AgentAvatarImg } from "./sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { assistantName$ } from "../../signals/branding.ts";
import { PersonalClaudeCodeDeviceAuthDialog } from "./components/settings/claude-code-device-auth-dialog.tsx";
import { PersonalCodexDeviceAuthDialog } from "./components/settings/codex-device-auth-dialog.tsx";

function localizedAnonymousTaglines(t: TFunction<"common">): string[] {
  return [
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.welcomeBack;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.whatsTheMove;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.goodToSeeYou;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.whatsOnYourMind;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.readyToRoll;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.buildSomething;
    }),
    t(($) => {
      return $.chat.agentPage.taglines.anonymous.whatAreWeWorkingOn;
    }),
  ];
}

function localizedUserTaglines(
  t: TFunction<"common">,
  agentName: string,
  userName: string,
): string[] {
  return [
    t(
      ($) => {
        return $.chat.agentPage.taglines.welcomeBack;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.whatsTheMove;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.goodToSeeYou;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.whatsOnYourMind;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.letsRoll;
      },
      {
        agentName,
        userName,
      },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.anotherWin;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.readyToBuild;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.enteredChat;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.goodToSeeYou;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.savedYourSeat;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.makeTodayCount;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.coffeeReady;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.knewYouWouldCome;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.whatsCooking;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.newIdeas;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.rightOnTime;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.whatAreWeWorkingOn;
      },
      { userName },
    ),
    t(
      ($) => {
        return $.chat.agentPage.taglines.theUsual;
      },
      { userName },
    ),
  ];
}

function useTagline(
  agentName: string | null | undefined,
  userName: string | null,
  index: number,
): string {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  if (agentName === undefined) {
    return "";
  }
  const taglines = userName
    ? localizedUserTaglines(t, agentName ?? assistantName, userName)
    : localizedAnonymousTaglines(t);
  return taglines[index % taglines.length];
}

function TypewriterText({
  text,
  speed = 40,
}: {
  text: string;
  speed?: number;
}) {
  const displayedText = useGet(chatPageTaglineDisplayed$);
  const typewriterRef = useSet(chatPageTaglineTypewriterRef$);
  const typewriterKey = `${text}:${String(speed)}`;

  return (
    <>
      <span
        key={typewriterKey}
        ref={typewriterRef}
        className="contents"
        data-typewriter-speed={String(speed)}
        data-typewriter-text={text}
      >
        {displayedText}
      </span>
      {displayedText.length < text.length && (
        <span className="inline-block w-[2px] h-[1em] bg-foreground/60 ml-0.5 align-middle animate-pulse" />
      )}
    </>
  );
}

function PinPill() {
  const { t } = useTranslation("agents");
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const pinnedStatus = useLastResolved(currentChatAgentPinned$);
  const [pinLoadable, saveAgentPinned] = useLoadableSet(setAgentPinned$);
  const pinSaving = pinLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  if (pinnedStatus !== false || !currentChatAgentId) {
    return null;
  }
  const handlePin = () => {
    detach(
      saveAgentPinned(
        { agentId: currentChatAgentId, pinned: true },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            onClick={handlePin}
            disabled={pinSaving}
            variant="quiet"
            size="icon-2xs"
            className="absolute -top-0.5 -right-0.5 rounded-full border border-surface-border bg-background shadow-sm hover:shadow-md disabled:opacity-50"
            aria-label={t(($) => {
              return $.sidebar.pin;
            })}
          >
            <Pin size={12} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">
            {t(($) => {
              return $.sidebar.pin;
            })}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * The frame owns the shape, and it is the only shape.
 *
 * This box already existed as the profile link's hover target, but it carried
 * no border, so the only edge anyone could see was the image's own
 * `rounded-full`. The agent artwork is a half figure drawn to the bottom of its
 * canvas, and a circle is at its narrowest exactly where the collar lands, so
 * the bottom of the sweater was pinched into a point by a mask with nothing
 * visible to attribute it to. `rounded-xl` is 14px, so it leaves 28px of
 * straight bottom under a collar that renders 14.7px wide, and the border makes
 * the frame answerable for the crop. `surface-border` is the registered token
 * for a four-sided hairline; `--border` is a stop lighter and would disagree
 * with the chips on the same screen.
 *
 * The size stays on the step the mobile layout already used rather than gaining
 * a breakpoint: against a single line of tagline, 64px is 1.78x the line box and
 * reads as a standee beside the text.
 */
const AGENT_AVATAR_FRAME =
  "h-14 w-14 shrink-0 flex items-center justify-center overflow-hidden rounded-xl border border-surface-border";
/**
 * Fills the frame's content box. Restating the frame's own `h-14 w-14` here
 * would overflow it by the border on every side and be silently clipped, since
 * the border box is what the frame sizes.
 */
const AGENT_AVATAR_IMAGE = "h-full w-full object-cover object-top";

function ChatAgentAvatar({ agentId }: { agentId: string | null | undefined }) {
  const { t } = useTranslation("agents");

  return (
    <div className="relative shrink-0">
      {agentId ? (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/agents/:agentId"
                options={{
                  pathParams: { agentId },
                }}
                aria-label={t(($) => {
                  return $.detail.viewProfile;
                })}
                className={cn(
                  AGENT_AVATAR_FRAME,
                  "cursor-pointer transition-colors duration-150 hover:bg-state-hover",
                )}
              >
                <AgentAvatarImg
                  name={agentId}
                  alt=""
                  className={AGENT_AVATAR_IMAGE}
                />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">
                {t(($) => {
                  return $.detail.viewProfile;
                })}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div className={AGENT_AVATAR_FRAME}>
          <AgentAvatarImg name="" alt="" className={AGENT_AVATAR_IMAGE} />
        </div>
      )}
      <PinPill />
    </div>
  );
}

export function AgentChatPage() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);
  const currentChatAgentDisplayName = useLastResolved(
    currentChatAgentDisplayName$,
  );

  const pageSignal = useGet(pageSignal$);
  const userFirstName = useLastResolved(user$)?.firstName ?? null;

  const composerSignals = useGet(agentChatComposerSignals$);
  const taskChipsEnabled = useGet(composerSignals.taskChips.enabled$);
  const setInput = useSet(composerSignals.draft.setDraftInput$);
  const saveDraft = useSet(composerSignals.draft.save$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const taglineStarted = useGet(chatPageTaglineStarted$);
  const tagline = useTagline(
    currentChatAgentDisplayName,
    userFirstName,
    taglineIndex,
  );

  const handleInputChange = (value: string) => {
    setInput(value);
    detach(saveDraft(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <GrowthEntryHeader />

      <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6">
        <div
          data-testid="agent-chat-scroll-content"
          className="mx-auto w-full max-w-[900px] flex flex-col items-stretch gap-10 pt-8 pb-[max(3rem,var(--sab))] sm:pt-[20vh] sm:pb-[max(10vh,var(--sab))]"
        >
          {/* The avatar is on the row before the line is: the tagline needs the
              agent's name, so the frame stands alone for as long as that takes
              to resolve. Centred alone and centred against a full line are two
              different places, and the step between them is what this animates.

              `calc(50% - 1.75rem)` is that step, written without measuring
              anything. 50% of this box puts its left edge on the row's centre,
              and 1.75rem is half of the avatar frame's `h-14`, so together they
              land the avatar's own centre there. The percentage resolves
              against the box as it is painted, so the frame that widens this
              box with the reserved line still draws the avatar exactly centred,
              and the settle runs from that position rather than from a stale
              one. Reduced motion keeps the offset off entirely, which resolves
              to the settled layout.

              While the offset is on, the reserved line hangs past the right
              edge; the scrollport above would answer that with a horizontal
              scrollbar, so the row clips its own axis. `clip` rather than
              `hidden` leaves the vertical axis visible for the pin button. */}
          <div className="flex w-full justify-center overflow-x-clip">
            <div
              data-testid="chat-greeting"
              data-settled={taglineStarted}
              className="flex min-w-0 items-center gap-4 transition-transform duration-500 ease-in-out motion-safe:translate-x-[calc(50%_-_1.75rem)] data-[settled=true]:translate-x-0"
            >
              <ChatAgentAvatar agentId={currentChatAgentId} />
              <h2
                aria-label={tagline}
                data-testid="chat-tagline"
                className="relative min-w-0 text-2xl sm:text-3xl font-semibold tracking-tight text-foreground"
              >
                {/* The tagline is typed one character at a time. Centred, every
                    character would widen the row and slide the avatar left, so
                    the full line holds the box from the first frame and the
                    typed text paints over it. The reserving copy stays in flow:
                    it has to wrap exactly the way the visible text will, which a
                    measured width could not promise. */}
                <span aria-hidden className="invisible">
                  {tagline}
                </span>
                <span className="absolute inset-0">
                  <TypewriterText text={tagline} />
                </span>
              </h2>
            </div>
          </div>

          <ChatComposer signals={composerSignals} />

          {taskChipsEnabled ? (
            <ComposerTaskChips signals={composerSignals} />
          ) : (
            <StartCards onSelectPrompt={handleInputChange} />
          )}
        </div>
      </main>
      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
    </div>
  );
}
