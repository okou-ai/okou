import type { ReactNode } from "react";
import type { HostedSiteVisibility } from "@okouai/api-contracts/contracts/hosted-site-access";
import { SegmentControl, SegmentControlItem } from "@okouai/ui";
import { Building2, Globe, Loader2, LockKeyhole } from "lucide-react";
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

/**
 * The audience is the DS segment control: its track and raised selection read
 * in both themes, where a hand-drawn `bg-gray-50` slider did not. The segments
 * size to their labels, and wrap to a second line instead of overflowing where
 * a locale's three labels exceed the popover (es, fr, pt-BR, id).
 *
 * Invitations grant access in every audience (the workspace description says
 * so), so the people section stays mounted for all three; the popover keeps
 * one height instead of collapsing when the audience widens.
 */
export function ShareAudienceChoices({
  selected: saved,
  pending,
  organizationName,
  saving,
  unavailable,
  onChange,
  children,
}: {
  readonly selected: HostedSiteVisibility | undefined;
  /** The last submitted choice; shown only while it is being saved. */
  readonly pending: HostedSiteVisibility | null;
  readonly organizationName: string | null;
  readonly saving: boolean;
  readonly unavailable: boolean;
  readonly onChange: (visibility: HostedSiteVisibility) => void;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const options = useAudienceOptions(organizationName);
  // Keep the submitted choice selected while it saves rather than clearing
  // the control; a failed save falls back to the saved value.
  const selected = (saving ? pending : null) ?? saved;
  const current = options.find((option) => {
    return option.value === selected;
  });
  return (
    <>
      {/* `null` keeps the control controlled while the audience is unknown. */}
      <SegmentControl<HostedSiteVisibility | null>
        aria-label={t(($) => {
          return $.artifacts.sharing.accessLabel;
        })}
        disabled={unavailable}
        aria-busy={saving}
        value={selected ?? null}
        onValueChange={(visibility) => {
          if (visibility) {
            onChange(visibility);
          }
        }}
        className="flex h-auto min-h-9 w-full"
      >
        {options.map(({ value, label, description }) => {
          return (
            <SegmentControlItem
              key={value}
              value={value}
              aria-label={label}
              aria-description={description}
              className="h-auto min-h-8 min-w-0 flex-auto self-stretch whitespace-normal py-1 text-center leading-tight"
            >
              {label}
            </SegmentControlItem>
          );
        })}
      </SegmentControl>
      {current && (
        <p className="mt-2 flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
          <current.Icon size={14} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 truncate">{current.description}</span>
          {saving && (
            <Loader2
              size={12}
              aria-hidden="true"
              className="shrink-0 animate-spin"
            />
          )}
        </p>
      )}
      <div className="mt-4">{children}</div>
    </>
  );
}
