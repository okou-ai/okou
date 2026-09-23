import type { UserPermissionGrantExpiresIn } from "@okouai/api-contracts/contracts/user-permission-grants";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import {
  parseUserPermissionGrantExpiresIn,
  USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS,
} from "../../signals/permission-allow/permission-grant-expiration.ts";

export function PermissionGrantDurationSelect({
  value,
  onValueChange,
  disabled,
  ariaLabel,
  className,
}: {
  value: UserPermissionGrantExpiresIn;
  onValueChange: (value: UserPermissionGrantExpiresIn) => void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const items = USER_PERMISSION_GRANT_EXPIRES_IN_OPTIONS.map((value) => {
    const label =
      value === "1h"
        ? t(($) => {
            return $.authorization.permission.durationOptions.oneHour;
          })
        : value === "24h"
          ? t(($) => {
              return $.authorization.permission.durationOptions.twentyFourHours;
            })
          : value === "7d"
            ? t(($) => {
                return $.authorization.permission.durationOptions.sevenDays;
              })
            : t(($) => {
                return $.authorization.permission.durationOptions.always;
              });
    return { value, label };
  });
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(nextValue, details) => {
        const parsed = parseUserPermissionGrantExpiresIn(nextValue);
        if (!parsed) {
          details.cancel();
          return;
        }
        onValueChange(parsed);
      }}
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={ariaLabel}
        className={cn("h-8 w-[116px] rounded-lg text-xs", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => {
          return (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
