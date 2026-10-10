import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { useLastResolved } from "ccstate-react";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  ComplianceBadges,
  SecurityDetailsLink,
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
      className="hidden shrink-0 flex-col items-center gap-2 px-6 pt-3 pb-5 sm:flex"
    >
      <p className="flex flex-wrap items-baseline justify-center gap-x-2 text-xs text-gray-700">
        <span>{title}</span>
        <SecurityDetailsLink className="underline decoration-gray-400 underline-offset-2 hover:text-foreground hover:decoration-current" />
      </p>
      <ComplianceBadges quiet className="flex flex-wrap justify-center gap-2" />
    </section>
  );
}
