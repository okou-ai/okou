import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  IconButton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  customConnectorCloudflareChoices$,
  customConnectorCloudflareEnabled$,
} from "../../../../signals/okou-page/settings/custom-connector-network.ts";
import { invalidateCloudflareAccess$ } from "../../../../signals/cloudflare-access.ts";
import { Link } from "../../../router/link.tsx";

function ConnectorNetworkDescription({
  enabled,
  unavailable,
}: {
  readonly enabled: boolean;
  readonly unavailable: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p
        id="custom-connector-cloudflare-description"
        className="text-sm text-muted-foreground"
      >
        {t(($) => {
          return enabled
            ? $.cloudflareAccess.connectorRecipients
            : $.cloudflareAccess.connectorDisabled;
        })}
      </p>
      {enabled && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.connectorRequirements;
          })}
        </p>
      )}
      {unavailable && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.connectorUnavailable;
          })}
        </p>
      )}
      {enabled && (
        <Link
          pathname="/connectors"
          options={{
            searchParams: new URLSearchParams({ scope: "private-network" }),
          }}
          target="_blank"
          rel="noopener noreferrer"
          className="w-fit text-sm text-muted-foreground underline hover:text-foreground"
        >
          {t(($) => {
            return $.cloudflareAccess.manage;
          })}
        </Link>
      )}
    </>
  );
}

function RefreshConfigurations({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const reload = useSet(invalidateCloudflareAccess$);
  return (
    <IconButton
      type="button"
      disabled={disabled}
      aria-label={t(($) => {
        return $.cloudflareAccess.refresh;
      })}
      onClick={reload}
    >
      <RefreshCw size={16} />
    </IconButton>
  );
}

export function CustomConnectorNetworkField({
  connector,
  configId,
  onChange,
  disabled,
}: {
  readonly connector?: CustomConnectorResponse;
  readonly configId: string;
  readonly onChange: (id: string) => void;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const enabled = useGet(customConnectorCloudflareEnabled$);
  const choices = useLoadable(customConnectorCloudflareChoices$);
  const saved = connector?.networkBinding;
  if (!enabled && !saved) {
    return null;
  }
  const configs = choices.state === "hasData" ? choices.data : null;
  const missingId = [saved?.configId, configId].filter((id): id is string => {
    return (
      !!id &&
      !configs?.some((config) => {
        return config.id === id;
      })
    );
  });
  const items = [
    {
      value: "none",
      label: t(($) => {
        return $.cloudflareAccess.noConnectorAccess;
      }),
    },
    ...(configs ?? []).map((config) => {
      return {
        value: config.id,
        label: config.name,
      };
    }),
    ...[...new Set(missingId)].map((id) => {
      return {
        value: id,
        label:
          saved?.configId === id && saved.status === "available"
            ? saved.name
            : t(($) => {
                return $.cloudflareAccess.bindingUnavailable;
              }),
      };
    }),
  ];
  return (
    <div className="grid gap-2">
      <label
        htmlFor="custom-connector-cloudflare"
        className="text-sm font-medium text-foreground"
      >
        {t(($) => {
          return $.cloudflareAccess.configuration;
        })}
      </label>
      <div className="flex items-center gap-2">
        <Select
          items={items}
          value={configId || "none"}
          onValueChange={(value) => {
            if (value !== null) {
              onChange(value === "none" ? "" : value);
            }
          }}
          disabled={disabled}
        >
          <SelectTrigger
            id="custom-connector-cloudflare"
            className="w-full"
            aria-describedby="custom-connector-cloudflare-description"
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
        {enabled && <RefreshConfigurations disabled={disabled} />}
      </div>
      <ConnectorNetworkDescription
        enabled={enabled}
        unavailable={
          saved?.status === "unavailable" && configId === saved.configId
        }
      />
      {enabled && choices.state === "loading" && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.loading;
          })}
        </p>
      )}
      {enabled &&
        (choices.state === "hasError" ||
          (choices.state === "hasData" && !configs)) && (
          <p role="alert" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.cloudflareAccess.loadFailed;
            })}
          </p>
        )}
    </div>
  );
}
