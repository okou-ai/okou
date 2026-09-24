import { Badge } from "@okouai/ui";
import {
  Globe,
  HeartPulse,
  LockKeyhole,
  Scale,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { securityPageUrl } from "./onboarding-security.ts";
import { ILLUSTRATION_BASE } from "./onboarding-step-parts.tsx";

/** A framework and its status, as the public security page states them. */
interface ComplianceItem {
  readonly icon: LucideIcon;
  readonly name: string;
  readonly status: string;
}

function useComplianceItems(): readonly ComplianceItem[] {
  const { t } = useTranslation();
  const inProgress = t(($) => {
    return $.onboarding.sourcesFirst.compliance.status.inProgress;
  });
  const compliant = t(($) => {
    return $.onboarding.sourcesFirst.compliance.status.compliant;
  });
  const aligned = t(($) => {
    return $.onboarding.sourcesFirst.compliance.status.aligned;
  });

  return [
    {
      icon: ShieldCheck,
      name: t(($) => {
        return $.onboarding.sourcesFirst.compliance.frameworks.soc2;
      }),
      status: inProgress,
    },
    {
      icon: Scale,
      name: t(($) => {
        return $.onboarding.sourcesFirst.compliance.frameworks.ccpa;
      }),
      status: compliant,
    },
    {
      icon: Globe,
      name: t(($) => {
        return $.onboarding.sourcesFirst.compliance.frameworks.gdpr;
      }),
      status: compliant,
    },
    {
      icon: HeartPulse,
      name: t(($) => {
        return $.onboarding.sourcesFirst.compliance.frameworks.hipaa;
      }),
      status: aligned,
    },
    {
      icon: LockKeyhole,
      name: t(($) => {
        return $.onboarding.sourcesFirst.compliance.frameworks.iso27001;
      }),
      status: aligned,
    },
  ];
}

export function OnboardingCompliance() {
  const { t, i18n } = useTranslation();
  const items = useComplianceItems();
  const title = t(($) => {
    return $.onboarding.sourcesFirst.compliance.title;
  });

  return (
    <section
      aria-label={title}
      className="mt-10 border-t border-t-gray-400 pt-6"
    >
      <img
        src={`${ILLUSTRATION_BASE}v3-compliance-fit_480.png`}
        srcSet={`${ILLUSTRATION_BASE}v3-compliance-fit_960.png 2x`}
        alt=""
        className="mb-4 h-28 w-auto"
      />
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        <a
          className="text-xs text-brand-text hover:text-brand-text-hover"
          href={securityPageUrl(i18n.resolvedLanguage ?? i18n.language)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t(($) => {
            return $.onboarding.sourcesFirst.compliance.link;
          })}
        </a>
      </div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {items.map((item) => {
          return (
            <li key={item.name}>
              <Badge className="text-xs text-muted-foreground">
                <item.icon className="text-foreground" aria-hidden="true" />
                <span>{item.name}</span>
                <span className="font-medium text-foreground">
                  {item.status}
                </span>
              </Badge>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
