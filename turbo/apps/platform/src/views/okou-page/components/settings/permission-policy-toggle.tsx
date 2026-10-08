import { Ban, Check, Contrast } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";

type PermissionPolicyToggleValue = "allow" | "deny";
type PermissionPolicyToggleState =
  | PermissionPolicyToggleValue
  | "ask"
  | "mixed";

export function PermissionPolicyMixedBadge() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-muted/60 px-2 text-[11px] font-medium text-muted-foreground">
      <Contrast size={12} className="shrink-0" />
      <span>
        {t(($) => {
          return $.connectors.permissions.actions.mixed;
        })}
      </span>
    </span>
  );
}

function permissionPolicyButtonClass({
  active,
  disabled,
  tone,
}: {
  active: boolean;
  disabled?: boolean;
  tone: PermissionPolicyToggleValue;
}): string {
  return `gap-1 rounded-none text-xs focus-visible:ring-inset focus-visible:ring-offset-0 disabled:opacity-100 [&_svg]:size-3 ${
    active
      ? tone === "allow"
        ? "bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-700 active:bg-emerald-500/10 dark:text-emerald-400 dark:hover:text-emerald-400"
        : "bg-rose-500/10 text-rose-700 hover:bg-rose-500/10 hover:text-rose-700 active:bg-rose-500/10 dark:text-rose-400 dark:hover:text-rose-400"
      : disabled
        ? "text-muted-foreground/50"
        : "text-muted-foreground hover:text-foreground hover:bg-state-hover"
  } ${disabled ? "cursor-default" : "cursor-pointer"}`;
}

export function PermissionPolicyToggle({
  disabled,
  policy,
  onAllow,
  onDeny,
}: {
  readonly disabled?: boolean;
  readonly policy: PermissionPolicyToggleState;
  readonly onAllow: () => void;
  readonly onDeny: () => void;
}) {
  const { t } = useTranslation();
  return (
    <span className="inline-flex shrink-0 overflow-hidden rounded-md text-xs font-medium border border-surface-border">
      <Button
        type="button"
        variant="quiet"
        size="xs"
        disabled={disabled}
        aria-pressed={policy === "allow"}
        onClick={onAllow}
        className={permissionPolicyButtonClass({
          active: policy === "allow",
          disabled,
          tone: "allow",
        })}
      >
        <Check size={12} />
        {t(($) => {
          return $.connectors.permissions.actions.allow;
        })}
      </Button>
      <Button
        type="button"
        variant="quiet"
        size="xs"
        disabled={disabled}
        aria-pressed={policy === "deny"}
        onClick={onDeny}
        className={`${permissionPolicyButtonClass({
          active: policy === "deny",
          disabled,
          tone: "deny",
        })} border-l-(length:--border-width-surface) border-l-surface-border`}
      >
        <Ban size={12} />
        {t(($) => {
          return $.connectors.permissions.actions.deny;
        })}
      </Button>
    </span>
  );
}
