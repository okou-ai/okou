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
import { securityPageUrl } from "./security-page.ts";

/** A framework and its status, as the public security page states them. */
interface ComplianceItem {
  readonly icon: LucideIcon;
  readonly name: string;
  readonly status: string;
}

function useComplianceItems(): readonly ComplianceItem[] {
  const { t } = useTranslation();
  const inProgress = t(($) => {
    return $.shared.compliance.status.inProgress;
  });
  const compliant = t(($) => {
    return $.shared.compliance.status.compliant;
  });
  const aligned = t(($) => {
    return $.shared.compliance.status.aligned;
  });

  return [
    {
      icon: ShieldCheck,
      name: t(($) => {
        return $.shared.compliance.frameworks.soc2;
      }),
      status: inProgress,
    },
    {
      icon: Scale,
      name: t(($) => {
        return $.shared.compliance.frameworks.ccpa;
      }),
      status: compliant,
    },
    {
      icon: Globe,
      name: t(($) => {
        return $.shared.compliance.frameworks.gdpr;
      }),
      status: compliant,
    },
    {
      icon: HeartPulse,
      name: t(($) => {
        return $.shared.compliance.frameworks.hipaa;
      }),
      status: aligned,
    },
    {
      icon: LockKeyhole,
      name: t(($) => {
        return $.shared.compliance.frameworks.iso27001;
      }),
      status: aligned,
    },
  ];
}

/** The heading every compliance block is announced by. */
export function useComplianceTitle(): string {
  const { t } = useTranslation();
  return t(($) => {
    return $.shared.compliance.title;
  });
}

/** Opens the public security page in the language the app is showing. */
export function SecurityDetailsLink({ className }: { className: string }) {
  const { t, i18n } = useTranslation();
  return (
    <a
      className={className}
      href={securityPageUrl(i18n.resolvedLanguage ?? i18n.language)}
      target="_blank"
      rel="noopener noreferrer"
    >
      {t(($) => {
        return $.shared.compliance.link;
      })}
    </a>
  );
}

/**
 * The five frameworks as status badges. Onboarding and the chat home show the
 * same list, so the claims cannot drift apart between the two surfaces.
 */
export function ComplianceBadges({ className }: { className?: string }) {
  const items = useComplianceItems();

  return (
    <ul className={className}>
      {items.map((item) => {
        return (
          <li key={item.name}>
            <Badge className="text-xs text-muted-foreground">
              <item.icon className="text-foreground" aria-hidden="true" />
              <span>{item.name}</span>
              <span className="font-medium text-foreground">{item.status}</span>
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}
