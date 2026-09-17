import { Ban, Check, Contrast } from "lucide-react";
import { useTranslation } from "react-i18next";

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
  return `flex h-7 items-center gap-1 px-2.5 text-xs font-medium transition-colors ${
    active
      ? tone === "allow"
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : "bg-rose-500/10 text-rose-700 dark:text-rose-400"
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
      <button
        type="button"
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
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={policy === "deny"}
        style={{
          borderLeft: "var(--border-width-surface) solid hsl(var(--gray-400))",
        }}
        onClick={onDeny}
        className={permissionPolicyButtonClass({
          active: policy === "deny",
          disabled,
          tone: "deny",
        })}
      >
        <Ban size={12} />
        {t(($) => {
          return $.connectors.permissions.actions.deny;
        })}
      </button>
    </span>
  );
}
