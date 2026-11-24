import type { Command } from "ccstate";
import type { ConnectorAccountPolicyChoice } from "@okouai/api-contracts/contracts/chat-connector-access";
import type { ConnectorAccountConnection } from "@okouai/api-contracts/contracts/connector-accounts";
import { useGet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@okouai/ui";

import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { permissionGrantExpiryText } from "../../../../signals/permission-allow/permission-grant-expiration.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { useConnectorAccountLabel } from "./use-connector-account-label.ts";

export function AccountPolicyControl({
  account,
  policy,
  updatePolicy$,
}: {
  readonly account: ConnectorAccountConnection;
  readonly policy:
    | { readonly enabled: boolean; readonly expiresAt: string | null }
    | undefined;
  readonly updatePolicy$: Command<
    Promise<void>,
    [string, ConnectorAccountPolicyChoice, AbortSignal]
  >;
}) {
  const { t } = useTranslation();
  const [saving, update] = useLoadableSet(updatePolicy$);
  const signal = useGet(pageSignal$);
  const label = useConnectorAccountLabel()(account);
  if (!policy) {
    return null;
  }
  const allow = t(($) => {
    return $.connectors.permissions.actions.allow;
  });
  const deny = t(($) => {
    return $.connectors.permissions.actions.deny;
  });
  const status = policy.enabled ? allow : deny;
  const duration = policy.expiresAt
    ? permissionGrantExpiryText(policy.expiresAt)
    : policy.enabled
      ? t(($) => {
          return $.connectors.permissions.always;
        })
      : null;
  const accessLabel = t(
    ($) => {
      return $.connectorChatAccess.accountAccess;
    },
    {
      account: label,
    },
  );
  const options: readonly (readonly [ConnectorAccountPolicyChoice, string])[] =
    [
      [
        "allow-always",
        t(($) => {
          return $.connectors.permissions.allowDuration.always;
        }),
      ],
      [
        "allow-1h",
        t(($) => {
          return $.connectors.permissions.allowDuration.oneHour;
        }),
      ],
      [
        "allow-24h",
        t(($) => {
          return $.connectors.permissions.allowDuration.twentyFourHours;
        }),
      ],
      [
        "allow-7d",
        t(($) => {
          return $.connectors.permissions.allowDuration.sevenDays;
        }),
      ],
    ];
  return (
    <div className="flex min-w-0 flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={[accessLabel, status, duration]
            .filter(Boolean)
            .join(", ")}
          disabled={saving.state === "loading"}
          render={
            <Button
              type="button"
              size="xs"
              variant="neutral"
              pending={saving.state === "loading"}
            />
          }
        >
          <span>{status}</span>
          {duration && (
            <span className="max-w-28 truncate text-xs text-muted-foreground">
              {duration}
            </span>
          )}
          <ChevronDown size={14} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {options.map(([value, text]) => {
            return (
              <DropdownMenuItem
                key={value}
                onClick={() => {
                  detach(update(account.id, value, signal), Reason.DomCallback);
                }}
              >
                {text}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              detach(update(account.id, "deny", signal), Reason.DomCallback);
            }}
          >
            {deny}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {saving.state === "hasError" && (
        <span role="alert" className="text-xs text-destructive">
          {t(($) => {
            return $.authorization.permission.errors.updateFailed;
          })}
        </span>
      )}
    </div>
  );
}
