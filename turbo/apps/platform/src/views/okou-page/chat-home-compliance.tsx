import { FeatureSwitchKey } from "@okouai/core";
import { useLastResolved } from "ccstate-react";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  ComplianceBadges,
  SecurityDetailsLink,
  useComplianceTitle,
} from "../components/compliance-badges.tsx";

/**
 * The compliance badges at the foot of the chat home. `mt-auto` takes the free
 * space under the composer column, so the row rests on the bottom of the
 * scrollport when the page is short and follows the content when it is not.
 *
 * Desktop only: below `sm` the composer is the page's footer, and a row under
 * it would sit between the field and the home indicator.
 */
export function ChatHomeCompliance() {
  const features = useLastResolved(featureSwitch$);
  const title = useComplianceTitle();

  if (!(features?.[FeatureSwitchKey.ChatHomeCompliance] ?? false)) {
    return null;
  }

  return (
    <section
      aria-label={title}
      className="mx-auto mt-auto hidden w-full max-w-[900px] flex-col items-center gap-3 pt-10 pb-6 sm:flex"
    >
      <p className="flex flex-wrap items-baseline justify-center gap-x-2 text-xs text-muted-foreground">
        <span>{title}</span>
        <SecurityDetailsLink className="text-foreground underline-offset-2 hover:underline" />
      </p>
      <ComplianceBadges className="flex flex-wrap justify-center gap-2" />
    </section>
  );
}
