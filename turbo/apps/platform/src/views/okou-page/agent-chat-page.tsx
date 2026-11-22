import { CapabilityHomePage } from "./capability-home-page.tsx";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { user$ } from "../../signals/auth.ts";
import { cn } from "@okouai/ui/lib/utils";

import {
  chatGreetingShouldAnimate$,
  chatPageTaglineIndex$,
  finishChatGreetingEntrance$,
} from "../../signals/okou-page/chat-page.ts";
import { agentChatComposerSignals$ } from "../../signals/okou-page/agent-composer-signals.ts";
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

/**
 * The new-chat page of an Agent, and of a Project. A Project's page is the
 * same page: it keeps the greeting, because the conversation is still with
 * Okou, and the composer's toolbar names the Project the chat starts in.
 */
export function AgentComposerPage() {
  const user = useLastResolved(user$);
  const userFirstName =
    user === undefined ? undefined : (user.firstName ?? null);

  const composerSignals = useGet(agentChatComposerSignals$);
  const taglineIndex = useGet(chatPageTaglineIndex$);
  const tagline = useTagline(userFirstName, taglineIndex);
  const animateGreeting = useGet(chatGreetingShouldAnimate$);
  const finishGreetingEntrance = useSet(finishChatGreetingEntrance$);
  const greetingIdentity = tagline;

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
    tagline === "" ? null : (
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
          <MyOkouAvatarButton size={56} />
        </span>
        {taglineHeading}
      </div>
    );
  return <CapabilityHomePage signals={composerSignals} heading={heading} />;
}

export function AgentChatPage({ project = false }: { project?: boolean }) {
  const showChatList = useGet(pwaChatListVisible$);
  return showChatList && !project ? <PwaChatListPage /> : <AgentComposerPage />;
}
