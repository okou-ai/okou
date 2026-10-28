import { Hand, UserRound } from "lucide-react";
import { Button } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";

import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

/**
 * Who the cloud browser belongs to right now. Taking over stops the live Run,
 * so the member keeps control until a newer Run starts; handing back drafts
 * the message that starts it.
 */
function browserController({
  liveRunId,
  latestRunId,
  takeoverRunId,
}: {
  readonly liveRunId: string | null;
  readonly latestRunId: string | null;
  readonly takeoverRunId: string | null;
}): "agent" | "member" | null {
  if (takeoverRunId !== null && takeoverRunId === latestRunId) {
    return "member";
  }
  return liveRunId === null ? null : "agent";
}

const PILL_CLASS_NAME =
  "pointer-events-auto absolute bottom-4 left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-2 rounded-full border border-[hsl(var(--gray-400))] bg-card py-1 pr-1 pl-3.5 text-[13px] leading-5 text-foreground shadow-[0_10px_15px_-3px_rgba(0,0,0,0.1),0_4px_6px_-2px_rgba(0,0,0,0.05)]";

export function BrowserPresence({
  thread,
}: {
  readonly thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const liveRunId = useGet(thread.liveRunId$);
  const latestRunId = useGet(thread.latestRunId$);
  const browser = thread.browserSessionSignals;
  const takeoverRunId = useGet(browser.takeoverRunId$);
  const setTakeoverRunId = useSet(browser.setTakeoverRunId$);
  const [stopOperation, activatePrimaryAction] = useLoadableSet(
    thread.composer.submission.activatePrimaryAction$,
  );
  const appendComposerText = useSet(thread.composer.editor.selectOrAppendText$);
  const pageSignal = useGet(pageSignal$);

  const controller = browserController({
    liveRunId,
    latestRunId,
    takeoverRunId,
  });

  if (controller === "agent") {
    return (
      <>
        <div
          aria-hidden
          data-browser-presence="agent"
          className="absolute inset-0 ring-2 ring-primary/60 ring-inset shadow-[inset_0_0_32px_hsl(var(--primary)/0.16)]"
        />
        <div role="status" className={PILL_CLASS_NAME}>
          <span
            aria-hidden
            className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
          />
          <span className="truncate">
            {t(($) => {
              return $.browserSession.presence.agentWorking;
            })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={stopOperation.state === "loading"}
            onClick={() => {
              setTakeoverRunId(liveRunId);
              detach(
                activatePrimaryAction("stop", pageSignal),
                Reason.DomCallback,
                "take over the cloud browser",
              );
            }}
            className="shrink-0 rounded-full"
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
      <div
        role="status"
        data-browser-presence="member"
        className={PILL_CLASS_NAME}
      >
        <UserRound
          aria-hidden
          size={14}
          className="shrink-0 text-muted-foreground"
        />
        <span className="truncate">
          {t(($) => {
            return $.browserSession.presence.memberInControl;
          })}
        </span>
        <Button
          type="button"
          size="xs"
          onClick={() => {
            appendComposerText(
              t(($) => {
                return $.browserSession.presence.handBackMessage;
              }),
            );
            setTakeoverRunId(null);
          }}
          className="shrink-0 rounded-full"
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
