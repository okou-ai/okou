import { Badge } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { securityPageUrl } from "./onboarding-security.ts";

/** A framework and its status, as the public security page states them. */
interface ComplianceItem {
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
      name: t(($) => {
        return $.onboarding.sourcesFirst.compliance.frameworks.soc2;
      }),
      status: inProgress,
    },
    {
      name: t(($) => {
        return $.onboarding.sourcesFirst.compliance.frameworks.ccpa;
      }),
      status: compliant,
    },
    {
      name: t(($) => {
        return $.onboarding.sourcesFirst.compliance.frameworks.gdpr;
      }),
      status: compliant,
    },
    {
      name: t(($) => {
        return $.onboarding.sourcesFirst.compliance.frameworks.hipaa;
      }),
      status: aligned,
    },
    {
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
