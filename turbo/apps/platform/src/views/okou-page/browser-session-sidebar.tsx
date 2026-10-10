import { ExternalLink, X } from "lucide-react";
import { Button } from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";

import type { BrowserSessionSignals } from "../../signals/chat-page/browser-session-block.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { BrowserSessionPanel } from "./browser-session-panel.tsx";
import { IconTooltip } from "../components/icon-tooltip.tsx";

interface BrowserSessionSidebarProps {
  readonly signals: BrowserSessionSignals;
  readonly onClose: () => void;
}

export function BrowserSessionSidebar({
  signals,
  onClose,
}: BrowserSessionSidebarProps) {
  const { t } = useTranslation();
  const closeBrowser = useSet(signals.close$);
  const pageSignal = useGet(pageSignal$);
  return (
    <aside
      aria-label={t(($) => {
        return $.browserSession.title;
      })}
      data-browser-session-sidebar
      className="flex h-full w-full min-h-0 flex-col border-l border-border/60 bg-background xl:border-l-0"
    >
      <div className="flex min-h-14 shrink-0 items-center gap-1 border-b border-border/60 px-4">
        <span className="min-w-0 flex-1 text-sm font-medium">
          {t(($) => {
            return $.browserSession.title;
          })}
        </span>
        <IconTooltip>
          <a
            href={signals.href}
            target="_blank"
            rel="noreferrer"
            aria-label={t(($) => {
              return $.browserSession.openNewPage;
            })}
            className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <ExternalLink size={16} />
          </a>
        </IconTooltip>
        <Button
          showTooltip
          type="button"
          onClick={() => {
            onClose();
            detach(
              closeBrowser(pageSignal),
              Reason.DomCallback,
              "close thread browser sidebar",
            );
          }}
          aria-label={t(($) => {
            return $.browserSession.close;
          })}
          variant="quiet"
          size="icon-sm"
        >
          <X size={16} />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <BrowserSessionPanel signals={signals} containLiveFrame />
      </div>
    </aside>
  );
}
