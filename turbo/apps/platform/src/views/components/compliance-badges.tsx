import { Badge } from "@okouai/ui";
import { cn } from "@okouai/ui/lib/utils";
import {
  Globe,
  HeartPulse,
  LockKeyhole,
  Scale,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * The compliance section of the public security page. Only the English page
 * carries it, so every locale links there rather than to a page without it.
 */
const COMPLIANCE_STATUS_URL =
  "https://www.okou.ai/en/security#security-compliance-title";

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

/** Opens the compliance section of the public security page. */
export function SecurityDetailsLink({ className }: { className: string }) {
  const { t } = useTranslation();
  return (
    <a
      className={className}
      href={COMPLIANCE_STATUS_URL}
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
 *
 * `quiet` is for a surface where the badges are ambient rather than the
 * content: the icon and the status drop to the muted ramp, and the status
 * keeps only a one-step contrast over the name.
 */
export function ComplianceBadges({
  className,
  quiet = false,
}: {
  className?: string;
  quiet?: boolean;
}) {
  const items = useComplianceItems();

  return (
    <ul className={className}>
      {items.map((item) => {
        return (
          <li key={item.name}>
            <Badge
              className={cn(
                "text-xs",
                quiet ? "text-gray-700" : "text-muted-foreground",
              )}
            >
              <item.icon
                className={quiet ? undefined : "text-foreground"}
                aria-hidden="true"
              />
              <span>{item.name}</span>
              <span
                className={
                  quiet
                    ? "text-muted-foreground"
                    : "font-medium text-foreground"
                }
              >
                {item.status}
              </span>
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}
