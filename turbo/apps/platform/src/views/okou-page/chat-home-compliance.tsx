import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useLastResolved } from "ccstate-react";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  ComplianceBadges,
  useComplianceTitle,
} from "../components/compliance-badges.tsx";

/** Whether the chat home carries the compliance row under its scroller. */
export function useChatHomeComplianceVisible(): boolean {
  const features = useLastResolved(featureSwitch$);
  return features?.[FeatureSwitchKey.ChatHomeCompliance] ?? false;
}

/**
 * The compliance badges at the foot of the chat home. The row sits outside the
 * page's scroller, so it stays on the first screen however tall the composer
 * column grows; the column scrolls above it instead.
 *
 * Desktop only: below `sm` the composer is the page's footer, and a row under
 * it would sit between the field and the home indicator.
 */
export function ChatHomeCompliance() {
  const visible = useChatHomeComplianceVisible();
  const title = useComplianceTitle();

  if (!visible) {
    return null;
  }

  return (
    <section
      aria-label={title}
      className="hidden shrink-0 justify-center border-t border-border/50 px-6 py-2 sm:flex"
    >
      <ComplianceBadges
        quiet
        className="flex flex-wrap justify-center gap-x-6 gap-y-2"
      />
    </section>
  );
}
