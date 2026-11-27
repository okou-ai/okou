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
import { now } from "../../../../lib/time.ts";
import { permissionGrantExpiryText } from "../../../../signals/permission-allow/permission-grant-expiration.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import { useConnectorAccountLabel } from "./use-connector-account-label.ts";

interface AccountPolicyControlProps {
  readonly account: ConnectorAccountConnection;
  readonly policy:
    | { readonly enabled: boolean; readonly expiresAt: string | null }
    | undefined;
  readonly updatePolicy$: Command<
    Promise<void>,
    [string, ConnectorAccountPolicyChoice, AbortSignal]
  >;
}

export function AccountPolicyControl({
  account,
  policy,
  updatePolicy$,
}: AccountPolicyControlProps) {
  const { t } = useTranslation();
  const [saving, update] = useLoadableSet(updatePolicy$);
  const signal = useGet(pageSignal$);
  const label = useConnectorAccountLabel()(account);
  if (!policy) {
    return null;
  }
  const accessLabel = t(
    ($) => {
      return $.connectorChatAccess.accountAccess;
    },
    {
      account: label,
    },
  );
  return (
    <AccessPolicyDropdown
      policy={policy}
      accessLabel={accessLabel}
      pending={saving.state === "loading"}
      error={
        saving.state === "hasError"
          ? t(($) => {
              return $.authorization.permission.errors.updateFailed;
            })
          : undefined
      }
      onChange={(choice) => {
        detach(update(account.id, choice, signal), Reason.DomCallback);
      }}
    />
  );
}

export function AccessPolicyDropdown({
  policy,
  accessLabel,
  pending,
  error,
  onChange,
}: {
  readonly policy: NonNullable<AccountPolicyControlProps["policy"]>;
  readonly accessLabel: string;
  readonly pending: boolean;
  readonly error?: string;
  readonly onChange: (choice: ConnectorAccountPolicyChoice) => void;
}) {
  const { t } = useTranslation();
  const allow = t(($) => {
    return $.connectors.permissions.actions.allow;
  });
  const deny = t(($) => {
    return $.connectors.permissions.actions.deny;
  });
  const status = policy.enabled ? allow : deny;
  const nowMs = now();
  const duration = policy.expiresAt
    ? permissionGrantExpiryText(policy.expiresAt, nowMs)
    : policy.enabled
      ? t(($) => {
          return $.connectors.permissions.always;
        })
      : null;
  const visibleDuration = policy.expiresAt
    ? permissionGrantExpiryText(policy.expiresAt, nowMs, "compact")
    : duration;
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
          disabled={pending}
          render={
            <Button
              type="button"
              size="xs"
              variant="neutral"
              className="max-w-full"
              pending={pending}
            />
          }
        >
          <span>{status}</span>
          {visibleDuration && (
            <span className="min-w-0 max-w-28 truncate text-xs text-muted-foreground">
              {visibleDuration}
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
                  onChange(value);
                }}
              >
                {text}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              onChange("deny");
            }}
          >
            {deny}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
