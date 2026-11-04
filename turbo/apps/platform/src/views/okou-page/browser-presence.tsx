import { Hand, UserRound } from "lucide-react";
import { Button } from "@okouai/ui";
import { useGet, useLoadable } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

const PILL_CLASS_NAME =
  "pointer-events-auto absolute bottom-4 left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-surface-border bg-card py-1 pr-1 pl-3.5 text-[13px] leading-5 text-foreground shadow-surface";

export function BrowserPresence({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const presence = thread.browserPresence;
  const controller = useGet(presence.controller$);
  const [takeOverOperation, takeOver] = useLoadableSet(presence.takeOver$);
  const [handBackOperation, handBack] = useLoadableSet(presence.handBack$);
  const takeOverSent = useLoadable(presence.takeOverSent$);
  const pageSignal = useGet(pageSignal$);

  if (controller === "agent") {
    return (
      <>
        <div
          aria-hidden
          data-browser-presence="agent"
          className="absolute inset-0 shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.4),inset_0_0_28px_hsl(var(--primary)/0.3)]"
        />
        <div className={PILL_CLASS_NAME}>
          <span
            aria-hidden
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
          />
          <span role="status" className="truncate">
            {t(($) => {
              return $.browserSession.presence.agentWorking;
            })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={takeOverOperation.state === "loading"}
            onClick={() => {
              detach(
                takeOver(
                  t(($) => {
                    return $.browserSession.presence.takeOverMessage;
                  }),
                  pageSignal,
                ),
                Reason.DomCallback,
                "take over the cloud browser",
              );
            }}
            className="shrink-0 rounded-full text-[13px]"
          >
            <Hand />
            {t(($) => {
              return $.browserSession.presence.takeOver;
            })}
          </Button>
        </div>
      </>
    );
  }

  if (controller === "member") {
    return (
      <div data-browser-presence="member" className={PILL_CLASS_NAME}>
        <UserRound
          aria-hidden
          size={14}
          className="shrink-0 text-muted-foreground"
        />
        <span role="status" className="truncate">
          {t(($) => {
            return $.browserSession.presence.memberInControl;
          })}
        </span>
        <Button
          type="button"
          size="xs"
          disabled={
            takeOverSent.state === "loading" ||
            handBackOperation.state === "loading"
          }
          onClick={() => {
            detach(
              handBack(
                t(($) => {
                  return $.browserSession.presence.handBackMessage;
                }),
                pageSignal,
              ),
              Reason.DomCallback,
              "hand the cloud browser back",
            );
          }}
          className="shrink-0 rounded-full text-[13px]"
        >
          {t(($) => {
            return $.browserSession.presence.handBack;
          })}
        </Button>
      </div>
    );
  }

  return null;
}
