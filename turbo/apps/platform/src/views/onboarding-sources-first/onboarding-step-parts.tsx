import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Radio, surfaceVariants, cn } from "@okouai/ui";
import { PreferenceCardRow } from "../okou-page/components/settings/preference-card-row.tsx";

/**
 * The onboarding steps are settings surfaces: a section heading with its
 * description, then the same preference rows and page surfaces the settings
 * panes already use.
 */
export function OnboardingSection({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/** A preference row whose control is the step's action. */
export function OnboardingRow({
  icon,
  title,
  description,
  status,
  children,
}: {
  readonly icon: LucideIcon;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly status?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <PreferenceCardRow
      icon={icon}
      title={title}
      description={description}
      status={status}
    >
      {children}
    </PreferenceCardRow>
  );
}

/** A selectable page surface, matching the connector cards' surface exactly. */
export function OnboardingChoiceCard({
  value,
  selected,
  title,
  description,
}: {
  readonly value: string;
  readonly selected: boolean;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <label
      className={cn(
        surfaceVariants({ interactive: true }),
        "flex cursor-pointer items-start gap-3 p-4",
        selected && "border-primary",
      )}
    >
      <Radio value={value} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="mt-1 block text-sm text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

/** Groups rows the way the settings panes stack them. */
export function OnboardingRowStack({
  children,
}: {
  readonly children: ReactNode;
}) {
  return <div className="flex flex-col gap-3">{children}</div>;
}
