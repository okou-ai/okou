import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { ChevronRight } from "lucide-react";
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
  loading,
  loadFailed,
}: {
  readonly enabled: boolean;
  readonly unavailable: boolean;
  readonly loading: boolean;
  readonly loadFailed: boolean;
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
      {enabled && loading && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.loading;
          })}
        </p>
      )}
      {enabled && loadFailed && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.cloudflareAccess.loadFailed;
          })}
        </p>
      )}
    </>
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
  const reload = useSet(invalidateCloudflareAccess$);
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
    <details className="group">
      <summary className="flex cursor-default list-none items-center gap-2 rounded-lg py-2.5 text-sm font-medium text-foreground hover:bg-state-hover">
        <ChevronRight
          size={16}
          className="shrink-0 transition-transform group-open:rotate-90"
        />
        <span>
          {t(($) => {
            return $.connectors.custom.create.advancedSettings;
          })}
        </span>
      </summary>
      <div className="mt-2 grid gap-2">
        <label
          htmlFor="custom-connector-cloudflare"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.cloudflareAccess.configuration;
          })}
        </label>
        <Select
          items={items}
          value={configId || "none"}
          onValueChange={(value) => {
            if (value !== null) {
              onChange(value === "none" ? "" : value);
            }
          }}
          onOpenChange={(open) => {
            if (
              open &&
              (choices.state === "hasError" ||
                (choices.state === "hasData" && !configs))
            ) {
              reload();
            }
          }}
          disabled={disabled}
        >
          <SelectTrigger
            id="custom-connector-cloudflare"
            variant="neutral"
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
        <ConnectorNetworkDescription
          enabled={enabled}
          unavailable={
            saved?.status === "unavailable" && configId === saved.configId
          }
          loading={choices.state === "loading"}
          loadFailed={
            choices.state === "hasError" ||
            (choices.state === "hasData" && !configs)
          }
        />
      </div>
    </details>
  );
}
