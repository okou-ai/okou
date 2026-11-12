import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { AlertTriangle, ChevronRight, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  customConnectorCloudflareChoices$,
  customConnectorCloudflareEnabled$,
} from "../../../../signals/okou-page/settings/custom-connector-network.ts";
import { invalidateCloudflareAccess$ } from "../../../../signals/cloudflare-access.ts";
import { Link } from "../../../router/link.tsx";

type NetworkSelection =
  | { readonly state: "available"; readonly name: string }
  | {
      readonly state:
        "none" | "removed" | "off" | "loading" | "error" | "unavailable";
    };

function networkSelection({
  configId,
  saved,
  enabled,
  loading,
  loadFailed,
  name,
}: {
  readonly configId: string;
  readonly saved: boolean;
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly name: string | undefined;
}): NetworkSelection {
  if (!configId) {
    return { state: saved ? "removed" : "none" };
  }
  if (!enabled) {
    return { state: "off" };
  }
  if (loading) {
    return { state: "loading" };
  }
  if (loadFailed) {
    return { state: "error" };
  }
  return name === undefined
    ? { state: "unavailable" }
    : { state: "available", name };
}

function ConnectorNetworkSummary({
  selection,
}: {
  readonly selection: NetworkSelection;
}) {
  const { t } = useTranslation();
  if (selection.state === "none") {
    return null;
  }
  const messages = {
    removed: t(($) => {
      return $.cloudflareAccess.connectorRemoval;
    }),
    off: t(($) => {
      return $.cloudflareAccess.connectorOff;
    }),
    loading: t(($) => {
      return $.cloudflareAccess.loading;
    }),
    error: t(($) => {
      return $.cloudflareAccess.loadFailed;
    }),
    unavailable: t(($) => {
      return $.cloudflareAccess.bindingUnavailable;
    }),
  };
  const label =
    selection.state === "available"
      ? selection.name
      : messages[selection.state];
  const warning =
    selection.state === "error" || selection.state === "unavailable";
  return (
    <span
      className={`ml-auto flex max-w-1/2 min-w-0 items-center gap-1 text-right text-xs font-normal ${warning ? "text-destructive" : "text-muted-foreground"}`}
    >
      {warning && <AlertTriangle size={12} className="shrink-0" aria-hidden />}
      <span className="min-w-0 break-words">
        {(selection.state === "available" ||
          selection.state === "unavailable") && (
          <>
            {t(($) => {
              return $.cloudflareAccess.configuration;
            })}
            {" · "}
          </>
        )}
        {label}
      </span>
    </span>
  );
}

function ConnectorNetworkLabel({ enabled }: { readonly enabled: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label
        htmlFor="custom-connector-cloudflare"
        className="text-sm font-medium text-foreground"
      >
        {t(($) => {
          return $.cloudflareAccess.configuration;
        })}
      </label>
      {enabled && (
        <Link
          pathname="/connectors"
          options={{
            searchParams: new URLSearchParams({ scope: "private-network" }),
          }}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
        >
          {t(($) => {
            return $.cloudflareAccess.manage;
          })}
          <ExternalLink size={12} aria-hidden />
        </Link>
      )}
    </div>
  );
}

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
        role={unavailable ? "status" : undefined}
        className="text-sm text-muted-foreground"
      >
        {t(($) => {
          return !enabled
            ? $.cloudflareAccess.connectorDisabled
            : unavailable
              ? $.cloudflareAccess.connectorUnavailable
              : $.cloudflareAccess.connectorHint;
        })}
      </p>
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

function ConnectorNetworkSelect({
  items,
  configId,
  onChange,
  disabled,
  retryOnOpen,
}: {
  readonly items: readonly { readonly value: string; readonly label: string }[];
  readonly configId: string;
  readonly onChange: (id: string) => void;
  readonly disabled: boolean;
  readonly retryOnOpen: boolean;
}) {
  const reload = useSet(invalidateCloudflareAccess$);
  return (
    <Select
      items={items}
      value={configId || "none"}
      onValueChange={(value) => {
        if (value !== null) {
          onChange(value === "none" ? "" : value);
        }
      }}
      onOpenChange={(open) => {
        if (open && retryOnOpen) {
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
  const loading = choices.state === "loading";
  const loadFailed =
    choices.state === "hasError" ||
    (choices.state === "hasData" && configs === null);
  const selection = networkSelection({
    configId,
    saved: saved !== undefined,
    enabled,
    loading,
    loadFailed,
    name: configs?.find((config) => {
      return config.id === configId;
    })?.name,
  });
  const missingId = [saved?.configId, configId].filter((id): id is string => {
    return (
      !!id &&
      !configs?.some((config) => {
        return config.id === id;
      })
    );
  });
  const missingLabel = t(($) => {
    return loading
      ? $.cloudflareAccess.loading
      : loadFailed
        ? $.cloudflareAccess.loadFailed
        : $.cloudflareAccess.bindingUnavailable;
  });
  const items = [
    {
      value: "none",
      label: t(($) => {
        return $.cloudflareAccess.noConnectorAccess;
      }),
    },
    ...(configs ?? []).map((config) => {
      return { value: config.id, label: config.name };
    }),
    ...[...new Set(missingId)].map((id) => {
      return {
        value: id,
        label:
          saved?.configId === id && saved.status === "available"
            ? saved.name
            : missingLabel,
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
            return $.cloudflareAccess.connectorAdvanced;
          })}
        </span>
        <ConnectorNetworkSummary selection={selection} />
      </summary>
      <div className="mt-2 grid gap-2">
        <ConnectorNetworkLabel enabled={enabled} />
        <ConnectorNetworkSelect
          items={items}
          configId={configId}
          onChange={onChange}
          disabled={disabled}
          retryOnOpen={loadFailed}
        />
        <ConnectorNetworkDescription
          enabled={enabled}
          unavailable={selection.state === "unavailable"}
          loading={loading}
          loadFailed={loadFailed}
        />
      </div>
    </details>
  );
}
