import { ShieldCheck } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@okouai/ui";
import {
  ComplianceBadges,
  ComplianceFrameworkSummary,
  SecurityDetailsLink,
  useComplianceTitle,
} from "../components/compliance-badges.tsx";

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
 * The band under a bottom-anchored composer: a 6px step and one `xs` row. The
 * capability home fills it with compliance, and a conversation keeps it empty,
 * so moving from one to the other never moves the composer.
 *
 * Desktop only, like the footer row on the plain chat home.
 */
const COMPOSER_FOOTNOTE_BAND = "hidden min-w-0 justify-center pt-1.5 sm:flex";

/**
 * Compliance under the composer on the capability home, as one quiet line of
 * framework names. Hovering or pressing it opens each framework's status and
 * the link to the public security page, so the claims stay one step away
 * without spreading five separate fragments around the page.
 */
export function CapabilityHomeCompliance() {
  const title = useComplianceTitle();

  return (
    <section aria-label={title} className={COMPOSER_FOOTNOTE_BAND}>
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={150}
          render={
            <Button
              variant="quiet"
              size="xs"
              className="max-w-full gap-1.5 text-xs font-normal text-gray-700"
            />
          }
        >
          <ShieldCheck aria-hidden />
          <span className="truncate">
            <ComplianceFrameworkSummary />
          </span>
        </PopoverTrigger>
        <PopoverContent side="top" className="flex flex-col gap-3">
          <p className="text-sm font-medium leading-5">{title}</p>
          <ComplianceBadges className="flex flex-col items-start gap-2" />
          <SecurityDetailsLink className="text-xs text-brand-text hover:text-brand-text-hover" />
        </PopoverContent>
      </Popover>
    </section>
  );
}

/**
 * The compliance line's room without the line, for a conversation's composer.
 * The row is 28px because the line's trigger is a `size="xs"` button.
 */
export function CapabilityHomeComplianceSpace() {
  return (
    <div
      aria-hidden
      data-slot="composer-footnote-space"
      className={COMPOSER_FOOTNOTE_BAND}
    >
      <div className="h-7" />
    </div>
  );
}
