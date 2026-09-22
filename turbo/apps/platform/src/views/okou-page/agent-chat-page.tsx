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
import { HomeTaskRecommendations } from "./home-task-recommendations.tsx";
import { GrowthEntryHeader } from "./growth-entry.tsx";
import {
  chatGreetingShouldAnimate$,
  chatPageTaglineIndex$,
  finishChatGreetingEntrance$,
} from "../../signals/okou-page/chat-page.ts";
import { agentChatComposerSignals$ } from "../../signals/okou-page/agent-composer-signals.ts";
import { avatarTextureEnabled$ } from "../../signals/external/feature-switch.ts";
import { AgentAvatarImg, useAgentAvatarTexture } from "./sidebar-shared.tsx";
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
  userName: string | null | undefined,
  index: number,
): string {
  const { t } = useTranslation();
  const assistantName = useGet(assistantName$);
  if (agentName === undefined || userName === undefined) {
    return "";
  }
  const taglines = userName
    ? localizedUserTaglines(t, agentName ?? assistantName, userName)
    : localizedAnonymousTaglines(t);
  return taglines[index % taglines.length];
}

const GREETING_TOKEN_STEP_MS = 70;

/**
 * The greeting arrives one word at a time, and nothing is ever cut.
 *
 * Each word is its own `inline-block` sitting in its final position from the
 * first frame, so the only thing that changes is the word's own ink. The line
 * is therefore at its finished width immediately: the row does not re-centre,
 * no ancestor has to clip a line that is still growing, and no measurement
 * runs per frame. The alternative that reads well at display sizes - a line
 * rising through a stationary clip - puts a hard horizontal edge across the
 * glyphs for the length of the travel, which on one 30px line at the top of
 * the page reads as a rendering fault rather than as craft.
 *
 * The space belongs to the outer span, not to the animated box, so a word's
 * blur cannot smear into its neighbour's gap.
 */
function GreetingTokens({
  text,
  animate,
  onAnimationComplete,
}: {
  text: string;
  animate: boolean;
  onAnimationComplete: () => void;
}) {
  const words = text.split(" ");

  return (
    <span aria-hidden data-slot="chat-tagline-text">
      {words.map((word, index) => {
        return (
          <span key={`${String(index)}-${word}`}>
            <span
              data-slot="chat-tagline-word"
              className={cn(
                "inline-block",
                animate && "motion-safe:animate-chat-greeting-token",
              )}
              style={
                animate
                  ? {
                      animationDelay: `${String((index + 1) * GREETING_TOKEN_STEP_MS)}ms`,
                    }
                  : undefined
              }
              onAnimationEnd={
                animate && index === words.length - 1
                  ? onAnimationComplete
                  : undefined
              }
            >
              {word}
            </span>
            {index < words.length - 1 ? " " : null}
          </span>
        );
      })}
    </span>
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
    <TooltipProvider delay={200}>
      <Tooltip>
        <TooltipTrigger
          render={
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
          }
        />
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
 *
 * With `avatarTexture` on, the hairline comes back off. It was added so that
 * something visible would be answerable for the crop; an opaque texture fills
 * the frame edge to edge and is answerable for it by itself, which leaves the
 * border as a second, weaker edge just inside the first.
 */
const AGENT_AVATAR_FRAME =
  "h-14 w-14 shrink-0 flex items-center justify-center overflow-hidden rounded-xl";
const AGENT_AVATAR_BORDER = "border border-surface-border";
/**
 * Fills the frame's content box. Restating the frame's own `h-14 w-14` here
 * would overflow it by the border on every side and be silently clipped, since
 * the border box is what the frame sizes. Dropping the border therefore gives
 * this 2px more to fill, which is the intent and not a second size step.
 */
const AGENT_AVATAR_IMAGE = "h-full w-full object-cover object-top";

function ChatAgentAvatar({ agentId }: { agentId: string | null | undefined }) {
  const { t } = useTranslation("agents");
  const textureEnabled = useGet(avatarTextureEnabled$);
  // Not every agent can take a texture: uploaded images and the flat default
  // avatar have no sweater or hair colour to clear. The frame follows the
  // answer rather than the switch, so those keep the hairline that is still
  // their only edge.
  const textureUrl = useAgentAvatarTexture(
    textureEnabled && agentId ? agentId : null,
  );

  return (
    <div className="relative shrink-0">
      {agentId ? (
        <TooltipProvider delay={200}>
          <Tooltip>
            <TooltipTrigger
              render={
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
                    "cursor-pointer",
                    textureUrl
                      ? // The frame's background is behind the texture and the
                        // border this used to recolour is gone, so hover needs a
                        // layer of its own above the artwork. Same token and the
                        // same 150ms, so hover does not change how it feels.
                        "group relative"
                      : cn(
                          AGENT_AVATAR_BORDER,
                          "transition-colors duration-150 hover:bg-state-hover",
                        ),
                  )}
                >
                  <AgentAvatarImg
                    name={agentId}
                    alt=""
                    className={AGENT_AVATAR_IMAGE}
                    textureUrl={textureUrl ?? undefined}
                  />
                  {textureUrl ? (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 bg-state-hover opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                    />
                  ) : null}
                </Link>
              }
            />
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
        <div className={cn(AGENT_AVATAR_FRAME, AGENT_AVATAR_BORDER)}>
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
  const user = useLastResolved(user$);
  const userFirstName =
    user === undefined ? undefined : (user.firstName ?? null);

  const composerSignals = useGet(agentChatComposerSignals$);
  const taskChipsEnabled = useGet(composerSignals.taskChips.enabled$);
  const setInput = useSet(composerSignals.draft.setDraftInput$);
  const saveDraft = useSet(composerSignals.draft.save$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline = useTagline(
    currentChatAgentDisplayName,
    userFirstName,
    taglineIndex,
  );
  const animateGreeting = useGet(chatGreetingShouldAnimate$);
  const finishGreetingEntrance = useSet(finishChatGreetingEntrance$);
  const greetingIdentity = `${currentChatAgentId ?? "none"}:${tagline}`;

  const handleInputChange = (value: string) => {
    setInput(value);
    detach(saveDraft(pageSignal), Reason.DomCallback);
  };

  return (
    <div className="relative flex flex-1 flex-col min-h-0">
      <GrowthEntryHeader />

      <main className="flex flex-1 min-h-0 flex-col overflow-y-auto px-4 sm:px-6">
        {/* Below `sm` the composer is the page's footer. Every text tool a
            phone user already has puts the field within thumb reach at the
            bottom of the screen, and this page was the one surface that asked
            them to reach back up to the top of the viewport for it.

            The reordering is CSS, not DOM: the composer keeps its authored
            position so a screen reader still meets the field right after the
            tagline that invites it, and `order` only decides where the box
            paints. `flex-1` gives the column the scrollport's height so the
            greeting's auto margins below have free space to take; the column
            still grows past it when the content is taller, and auto margins
            collapse to nothing there, so the composer scrolls with the page
            instead of holding the floor. */}
        <div
          data-testid="agent-chat-scroll-content"
          className="mx-auto w-full max-w-[900px] flex flex-1 flex-col items-stretch gap-6 pt-8 pb-0 sm:flex-none sm:gap-10 sm:pt-[20vh] sm:pb-safe-or-[10vh]"
        >
          {/* The greeting keeps the space the composer left behind rather than
              staying pinned under the header with a screen-deep hole under it.
              Both margins are auto, so the free space is split above and below
              it and the line lands in the middle of what is left. The row is at
              its final width on the first frame, so it is centered once and
              never moves again. */}
          <div className="flex min-h-14 w-full justify-center my-auto sm:my-0">
            {/* The async agent identity and name leave the first renders
                incomplete. Reserve the finished row's height, but do not let
                the avatar run a throwaway entrance before the real greeting
                can mount under its final identity. */}
            {currentChatAgentId === undefined || tagline === "" ? null : (
              <div
                key={greetingIdentity}
                data-slot="chat-greeting"
                data-testid="chat-greeting"
                className="flex max-w-full items-center gap-4"
              >
                {/* The avatar is the greeting's first word. Only the first
                    greeting in this App lifetime takes the entrance; changing
                    agents or opening another new chat gets no second entrance. */}
                <span
                  data-slot="chat-greeting-avatar"
                  className={cn(
                    "shrink-0",
                    animateGreeting &&
                      "motion-safe:animate-chat-greeting-token",
                  )}
                >
                  <ChatAgentAvatar agentId={currentChatAgentId} />
                </span>
                <h2
                  aria-label={tagline}
                  data-testid="chat-tagline"
                  className="min-w-0 text-2xl sm:text-3xl font-semibold tracking-tight text-foreground"
                >
                  <GreetingTokens
                    text={tagline}
                    animate={animateGreeting}
                    onAnimationComplete={finishGreetingEntrance}
                  />
                </h2>
              </div>
            )}
          </div>

          {/* The same two the thread page's footer carries.
              `data-chat-composer` names the box the soft keyboard has to
              reveal, and `pb-safe-or-2` takes the larger of the gutter and the
              home indicator's reserve — the reserve being keyboard-aware, so
              the card clears the gesture bar without floating above the
              keyboard. */}
          <div
            data-chat-composer
            className="order-3 pb-safe-or-2 sm:order-none sm:pb-0"
          >
            <ChatComposer signals={composerSignals} />
          </div>

          {/* Above the generic starting points and below the composer: these
              cards describe the member's own unfinished work, so they are only
              worth the position when there are any, and the section renders
              nothing when there are not. */}
          {/* `order-1` keeps the mobile column greeting, recommendations,
              starting points, composer: the composer's own `order-3` is what
              holds it at the bottom within thumb reach, so this section takes
              the step above the chips rather than sharing theirs. */}
          <div className="order-1 sm:order-none">
            <HomeTaskRecommendations agentId={currentChatAgentId} />
          </div>

          <div className="order-2 sm:order-none">
            {taskChipsEnabled ? (
              <ComposerTaskChips signals={composerSignals} />
            ) : (
              <StartCards onSelectPrompt={handleInputChange} />
            )}
          </div>
        </div>
      </main>
      <PersonalClaudeCodeDeviceAuthDialog />
      <PersonalCodexDeviceAuthDialog />
    </div>
  );
}
