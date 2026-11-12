import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button, cn } from "@okouai/ui";
import {
  ComplianceBadges,
  useComplianceTitle,
} from "../components/compliance-badges.tsx";
import {
  finishHomeComplianceFold$,
  hideHomeCompliance$,
  homeComplianceFolding$,
  homeComplianceHidden$,
} from "../../signals/okou-page/home-compliance.ts";

/**
 * The compliance badges at the foot of the chat home. The row sits outside the
 * page's scroller, so it stays on the first screen however tall the composer
 * column grows; the column scrolls above it instead.
 *
 * Desktop only: below `sm` the composer is the page's footer, and a row under
 * it would sit between the field and the home indicator.
 */
export function ChatHomeCompliance() {
  const title = useComplianceTitle();

  return (
    <section
      aria-label={title}
      className="@container hidden shrink-0 justify-center border-t border-border/50 bg-gray-50 px-6 py-2 sm:flex"
    >
      <ComplianceBadges
        quiet
        className="flex flex-wrap justify-center gap-x-8 gap-y-2 @4xl:divide-x @4xl:divide-border/50 @4xl:gap-x-0 @4xl:[&>li]:px-4"
      />
    </section>
  );
}

/**
 * Compliance at the foot of the capability cards: every framework and its
 * status, in a block one tier quieter than the cards — their surface at 60%,
 * no drawing, nothing to press but the hide control — so it closes the grid
 * without competing with it. It sits 12px under the cards, the same step as
 * between the card rows. A member can hide it for good on this device; the
 * block then folds its own height away, so the cards settle instead of
 * jumping. On the first home of the session it rises in after the cards.
 *
 * Desktop only, like the footer row on the plain chat home.
 */
export function CapabilityHomeCompliance({
  entrance,
}: {
  readonly entrance: boolean;
}) {
  const { t } = useTranslation();
  const title = useComplianceTitle();
  const hidden = useGet(homeComplianceHidden$);
  const folding = useGet(homeComplianceFolding$);
  const hide = useSet(hideHomeCompliance$);
  const finishFold = useSet(finishHomeComplianceFold$);
  if (hidden && !folding) {
    return null;
  }
  return (
    <section
      aria-label={title}
      aria-hidden={folding || undefined}
      inert={folding}
      className={cn(
        "-mt-2 hidden grid-rows-[1fr] transition-[grid-template-rows,opacity,margin-top] duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none sm:grid",
        folding && "-mt-5 grid-rows-[0fr] opacity-0",
        entrance &&
          "motion-safe:animate-capability-row-in [--capability-row-delay:280ms]",
      )}
      onTransitionEnd={(event) => {
        // Rows, opacity and margin fold on one timing; the first of them to
        // end on the block itself, not a control inside it, ends the fold.
        if (folding && event.target === event.currentTarget) {
          finishFold();
        }
      }}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="flex min-h-12 items-center gap-4 rounded-surface bg-muted/60 py-2.5 pr-3 pl-6">
          <ComplianceBadges
            quiet
            className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1 [&_li>span]:text-xs [&_li>span]:leading-5 [&_svg]:size-3.5"
          />
          <Button
            variant="quiet"
            size="icon-sm"
            aria-label={t(($) => {
              return $.shared.compliance.hide;
            })}
            className="-mr-1.5 size-7 shrink-0 text-muted-foreground"
            onClick={() => {
              // Reduced motion has no fold to wait for, so the block goes at once.
              hide(!matchMedia("(prefers-reduced-motion: reduce)").matches);
            }}
          >
            <X aria-hidden />
          </Button>
        </div>
      </div>
    </section>
  );
}
