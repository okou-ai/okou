import {
  ComplianceBadges,
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
        className="flex flex-wrap justify-center gap-x-8 gap-y-2 @4xl:divide-x @4xl:divide-border/50 @4xl:gap-x-0"
      />
    </section>
  );
}
