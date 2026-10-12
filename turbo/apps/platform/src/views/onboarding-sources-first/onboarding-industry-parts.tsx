import {
  ComplianceBadges,
  SecurityDetailsLink,
  useComplianceTitle,
} from "../components/compliance-badges.tsx";
import { ILLUSTRATION_BASE } from "./onboarding-step-parts.tsx";

export function OnboardingCompliance() {
  const title = useComplianceTitle();

  return (
    <section aria-label={title} className="mt-10">
      <img
        src={`${ILLUSTRATION_BASE}v3-compliance-fit_480.png`}
        srcSet={`${ILLUSTRATION_BASE}v3-compliance-fit_960.png 2x`}
        alt=""
        className="mb-4 h-28 w-auto"
      />
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        <SecurityDetailsLink className="text-xs text-brand-text hover:text-brand-text-hover" />
      </div>
      <ComplianceBadges className="mt-3 flex flex-wrap gap-2" />
    </section>
  );
}
