import { CapabilityHomePage } from "./capability-home-page.tsx";
import { defaultAgentId$ } from "../../signals/agent.ts";
import { singleAgentEnabled$ } from "../../signals/single-agent.ts";
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
import { currentChatAgentId$ } from "../../signals/agent-chat.ts";
import {
  setAgentPinned$,
  currentChatAgentPinned$,
} from "../../signals/okou-page/pinned-agents.ts";

import { detach, Reason } from "../../signals/utils.ts";
import {
  chatGreetingShouldAnimate$,
  chatPageTaglineIndex$,
  finishChatGreetingEntrance$,
} from "../../signals/okou-page/chat-page.ts";
import { agentChatComposerSignals$ } from "../../signals/okou-page/agent-composer-signals.ts";
import { AgentAvatarImg, useAgentAvatarTexture } from "./sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { pwaChatListVisible$ } from "../../signals/okou-page/pwa-navigation.ts";
import { PwaChatListPage } from "./pwa-chat-list-page.tsx";
import { MyOkouAvatarButton } from "./my-okou-avatar-button.tsx";

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
  userName: string | null | undefined,
  index: number,
): string {
  const { t } = useTranslation();
  if (userName === undefined) {
    return "";
  }
  const taglines = userName
    ? localizedUserTaglines(t, userName)
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
  const singleAgent = useGet(singleAgentEnabled$);
  return singleAgent ? null : <LegacyPinPill />;
}

function LegacyPinPill() {
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
 * With a brand texture behind the artwork, the hairline comes back off. It was
 * added so that something visible would be answerable for the crop; an opaque
 * texture fills the frame edge to edge and is answerable for it by itself,
 * which leaves the border as a second, weaker edge just inside the first.
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
  const singleAgent = useGet(singleAgentEnabled$);
  const defaultId = useLastResolved(defaultAgentId$);
  return singleAgent && agentId === defaultId ? (
    // My Okou's greeting is the one place Okou is shown large and alone, so it
    // is the one place the avatar moves. The shared avatar owns its frame and
    // texture, and holds still for reduced-motion users.
    <MyOkouAvatarButton size={56} />
  ) : (
    <LegacyChatAgentAvatar agentId={agentId} />
  );
}

function LegacyChatAgentAvatar({
  agentId,
}: {
  agentId: string | null | undefined;
}) {
  const { t } = useTranslation("agents");
  // Not every agent can take a texture: uploaded images and the flat default
  // avatar have no sweater or hair colour to clear. The frame follows that
  // answer, so those keep the hairline that is still their only edge.
  const textureUrl = useAgentAvatarTexture(agentId ?? null);
  const hoverLayer = (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 bg-state-hover opacity-0 transition-opacity duration-150 group-hover:opacity-100"
    />
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
                    textureUrl
                      ? // The frame's background is behind the texture and a
                        // textured frame has no border to recolour, so hover
                        // needs a layer of its own above the artwork. Same token
                        // and the same 150ms, so hover does not change how it
                        // feels.
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
                  {textureUrl ? hoverLayer : null}
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

/**
 * The new-chat page of an Agent, and of a Project. A Project's page is the
 * same page: it keeps the greeting, because the conversation is still with
 * Okou, and the composer's toolbar names the Project the chat starts in.
 */
export function AgentComposerPage() {
  const currentChatAgentId = useLastResolved(currentChatAgentId$);

  const user = useLastResolved(user$);
  const userFirstName =
    user === undefined ? undefined : (user.firstName ?? null);

  const composerSignals = useGet(agentChatComposerSignals$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline = useTagline(userFirstName, taglineIndex);
  const animateGreeting = useGet(chatGreetingShouldAnimate$);
  const finishGreetingEntrance = useSet(finishChatGreetingEntrance$);
  const greetingIdentity = `${currentChatAgentId ?? "none"}:${tagline}`;

  const taglineHeading = (
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
  );
  const heading =
    currentChatAgentId === undefined || tagline === "" ? null : (
      <div
        key={greetingIdentity}
        data-slot="chat-greeting"
        data-testid="chat-greeting"
        className="flex min-w-0 max-w-full flex-1 items-center gap-4"
      >
        {/* The avatar fades in place while the greeting words settle.
            Only the first greeting in this App lifetime takes the entrance;
            changing agents or opening another new chat gets no second one. */}
        <span
          data-slot="chat-greeting-avatar"
          className={cn(
            "shrink-0",
            animateGreeting && "motion-safe:animate-chat-greeting-avatar",
          )}
        >
          <ChatAgentAvatar agentId={currentChatAgentId} />
        </span>
        {taglineHeading}
      </div>
    );
  return (
    <CapabilityHomePage
      signals={composerSignals}
      heading={heading}
      entrance={animateGreeting}
    />
  );
}

export function AgentChatPage({ project = false }: { project?: boolean }) {
  const showChatList = useGet(pwaChatListVisible$);
  return showChatList && !project ? <PwaChatListPage /> : <AgentComposerPage />;
}
