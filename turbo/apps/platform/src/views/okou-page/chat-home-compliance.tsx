import {
  ComplianceBadges,
  useComplianceTitle,
} from "../components/compliance-badges.tsx";

/**
 * Compliance at the foot of the capability cards: every framework and its
 * status, in a block one tier quieter than the cards — their surface at 60%,
 * no drawing, nothing to press — so it closes the grid without competing with
 * it. It sits 12px under the cards, the same step as between the card rows.
 *
 * Shown only when the container is wide enough to fit all five items on a
 * single line; narrower layouts hide it rather than wrapping or clipping.
 */
export function CapabilityHomeCompliance() {
  const title = useComplianceTitle();
  return (
    <section
      aria-label={title}
      className="-mt-2 hidden min-h-12 items-center overflow-hidden rounded-surface bg-muted/60 px-6 py-2.5 @[840px]:flex"
    >
      <ComplianceBadges
        quiet
        className="flex min-w-0 flex-1 flex-nowrap items-center gap-x-4 [&_li>span]:text-xs [&_li>span]:leading-5 [&_svg]:size-3.5"
      />
    </section>
  );
}
