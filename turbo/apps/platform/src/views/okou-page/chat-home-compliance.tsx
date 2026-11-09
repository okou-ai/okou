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
        className="flex flex-wrap justify-center gap-x-8 gap-y-2 @4xl:divide-x @4xl:divide-border/50 @4xl:gap-x-0 @4xl:[&>li]:px-4"
      />
    </section>
  );
}

/**
 * The compliance badges directly under the capability cards. The row shares
 * the cards' column, so once it fits on one line it spreads across the card
 * grid with its outer items on the cards' 20px content inset, and it scrolls
 * with the cards on a short window.
 *
 * Desktop only, like the footer row it replaces on this page.
 */
export function CapabilityHomeCompliance() {
  const title = useComplianceTitle();

  return (
    <section aria-label={title} className="hidden pt-2 sm:block">
      <ComplianceBadges
        quiet
        className="flex flex-wrap justify-center gap-x-6 gap-y-2 px-5 @3xl:justify-between"
      />
    </section>
  );
}
