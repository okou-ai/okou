import type { ReactNode } from "react";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import type { HostedSiteVisibility } from "@okouai/api-contracts/contracts/hosted-site-access";
import { RadioGroup, cn } from "@okouai/ui";
import { Building2, Globe, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";

function useAudienceOptions(organizationName: string | null) {
  const { t } = useTranslation();
  return [
    {
      value: "private",
      Icon: LockKeyhole,
      label: t(($) => {
        return $.artifacts.people.restricted;
      }),
      description: t(($) => {
        return $.artifacts.people.restrictedDescription;
      }),
    },
    {
      value: "organization",
      Icon: Building2,
      label: t(($) => {
        return $.artifacts.people.workspace;
      }),
      description:
        organizationName === null
          ? t(($) => {
              return $.artifacts.people.workspaceDescriptionUnnamed;
            })
          : t(
              ($) => {
                return $.artifacts.people.workspaceDescription;
              },
              { organization: organizationName },
            ),
    },
    {
      value: "public",
      Icon: Globe,
      label: t(($) => {
        return $.artifacts.people.anyone;
      }),
      description: t(($) => {
        return $.artifacts.sharing.publicOption;
      }),
    },
  ] as const;
}

export function ShareAudienceChoices({
  selected,
  organizationName,
  saving,
  unavailable,
  onChange,
  children,
}: {
  readonly selected: HostedSiteVisibility | undefined;
  readonly organizationName: string | null;
  readonly saving: boolean;
  readonly unavailable: boolean;
  readonly onChange: (visibility: HostedSiteVisibility) => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const options = useAudienceOptions(organizationName);
  const expanded = selected === "private";
  return (
    <>
      <div className="rounded-xl border border-border p-1">
        <RadioGroup
          aria-label={t(($) => {
            return $.artifacts.sharing.accessLabel;
          })}
          aria-orientation="horizontal"
          disabled={unavailable}
          aria-busy={saving}
          value={saving ? null : (selected ?? null)}
          onValueChange={onChange}
          className="relative grid grid-cols-3 gap-1"
        >
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 w-[calc((100%_-_0.5rem)/3)] rounded-lg bg-gray-50 motion-safe:transition-[translate,opacity] motion-safe:duration-[220ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
              selected === "organization" &&
                "translate-x-[calc(100%_+_0.25rem)]",
              selected === "public" && "translate-x-[calc(200%_+_0.5rem)]",
              (!selected || saving) && "opacity-0",
            )}
          />
          {options.map(({ value, Icon, label, description }) => {
            return (
              <RadioPrimitive.Root
                key={value}
                value={value}
                nativeButton
                render={<button type="button" />}
                aria-label={label}
                aria-description={description}
                aria-busy={saving}
                className="relative flex min-h-14 min-w-0 select-none flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-center text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-state-hover data-checked:text-foreground data-disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon size={16} aria-hidden="true" />
                <span>{label}</span>
              </RadioPrimitive.Root>
            );
          })}
        </RadioGroup>
      </div>
      <p
        key={selected}
        className="mx-2 mt-3 text-xs leading-5 text-muted-foreground motion-safe:transition-opacity motion-safe:duration-[140ms] motion-safe:starting:opacity-35"
      >
        {
          options.find((option) => {
            return option.value === selected;
          })?.description
        }
      </p>
      <div
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          "grid motion-safe:transition-[grid-template-rows,opacity] motion-safe:duration-[220ms] motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)]",
          expanded
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">{children}</div>
      </div>
    </>
  );
}
