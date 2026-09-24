import { Check, ChevronDown, Filter, Loader2 } from "lucide-react";
import { useGet, useSet } from "ccstate-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuCheckboxItemIndicator,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@okouai/ui";
import type { NetworkLogEntry } from "@okouai/api-contracts/contracts/runs";
import { useTranslation } from "react-i18next";
import { type BadgeColor, formatSize, InlineBadge } from "./network-badge.tsx";
import { CapturedBodySections } from "./captured-body-sections.tsx";
import {
  defaultNetworkLogTypes,
  type NetworkLogTypeFilter,
  networkLogExpandedRows$,
  networkLogTypeFilter$,
  setNetworkLogTypeFilter$,
  toggleNetworkLogRowExpanded$,
} from "../../../signals/okou-page/network-log-ui.ts";
import { i18n } from "../../../i18n/index.ts";
import type enUSCommon from "../../../i18n/locales/en-US/common.json";
import { formatAppNumber } from "../../../i18n/format.ts";
import { formatActivityClockTime } from "../../../signals/activity-page/activity-time.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(timestamp: string): string {
  return formatActivityClockTime(timestamp);
}

function formatLatency(ms: number | undefined | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 1000) {
    return `${formatAppNumber(ms, {
      maximumFractionDigits: 0,
      useGrouping: false,
    })}ms`;
  }
  return `${formatAppNumber(ms / 1000, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
    useGrouping: false,
  })}s`;
}

function entryType(entry: NetworkLogEntry): string {
  return entry.type ? entry.type.toUpperCase() : "HTTP";
}

function nonEmptyLogField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function hostPortTarget(entry: NetworkLogEntry): string | undefined {
  const host = nonEmptyLogField(entry.host);
  if (!host) {
    return undefined;
  }
  return entry.port !== undefined ? `${host}:${entry.port}` : host;
}

function networkTarget(entry: NetworkLogEntry, isHttp: boolean): string {
  if (isHttp) {
    return nonEmptyLogField(entry.url) ?? hostPortTarget(entry) ?? "—";
  }
  return `${
    nonEmptyLogField(entry.host) ??
    i18n.t(($) => {
      return $.activity.network.unknown;
    })
  }:${entry.port ?? 0}`;
}

function typeBadgeColor(type: string): BadgeColor {
  if (type === "HTTP") {
    return "blue";
  }
  if (type === "TCP") {
    return "violet";
  }
  if (type === "UDP" || type === "ICMP") {
    return "amber";
  }
  if (type === "DNS") {
    return "teal";
  }
  return "muted";
}

function statusColor(status: number | undefined): string {
  if (!status) {
    return "text-muted-foreground";
  }
  if (status < 300) {
    return "text-green-600 dark:text-green-400";
  }
  if (status < 400) {
    return "text-yellow-600 dark:text-yellow-400";
  }
  return "text-red-600 dark:text-red-400";
}

function latencyColor(ms: number | undefined | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return "text-muted-foreground";
  }
  if (ms < 500) {
    return "text-green-600 dark:text-green-400";
  }
  if (ms < 2000) {
    return "text-yellow-600 dark:text-yellow-400";
  }
  return "text-red-600 dark:text-red-400";
}

// ---------------------------------------------------------------------------
// Row components
// ---------------------------------------------------------------------------

function TypeBadge({
  type,
  action,
}: {
  type: string;
  action?: NetworkLogEntry["action"];
}) {
  if (action === "BLOCK") {
    return (
      <InlineBadge color="warning">
        {i18n.t(($) => {
          return $.activity.network.actions.block;
        })}
      </InlineBadge>
    );
  }

  const denied = action === "DENY";
  return (
    <InlineBadge color={denied ? "red" : typeBadgeColor(type)}>
      <span className={denied ? "line-through" : undefined}>{type}</span>
    </InlineBadge>
  );
}

function typeRank(type: string): number {
  switch (type) {
    case "HTTP": {
      return 0;
    }
    case "DNS": {
      return 1;
    }
    case "TCP": {
      return 2;
    }
    case "UDP": {
      return 3;
    }
    case "ICMP": {
      return 4;
    }
    default: {
      return Number.MAX_SAFE_INTEGER;
    }
  }
}

function sortTypes(types: string[]): string[] {
  return [...types].sort((a, b) => {
    const rankDelta = typeRank(a) - typeRank(b);
    if (rankDelta !== 0) {
      return rankDelta;
    }
    return a.localeCompare(b);
  });
}

function networkTypeOptions(
  networkLogs: NetworkLogEntry[],
  typeFilter: NetworkLogTypeFilter,
): string[] {
  const selectedTypes = typeFilter.mode === "selected" ? typeFilter.types : [];
  const types = new Set<string>([
    ...defaultNetworkLogTypes(),
    ...selectedTypes,
  ]);
  for (const entry of networkLogs) {
    types.add(entryType(entry));
  }
  return sortTypes(Array.from(types));
}

function selectedTypeValues(
  typeFilter: NetworkLogTypeFilter,
  typeOptions: string[],
): string[] {
  return typeFilter.mode === "all" ? typeOptions : [...typeFilter.types];
}

function setSelectedType(
  typeFilter: NetworkLogTypeFilter,
  typeOptions: string[],
  type: string,
  checked: boolean,
): NetworkLogTypeFilter {
  const selectedTypes = selectedTypeValues(typeFilter, typeOptions);
  const nextTypes = checked
    ? sortTypes([...selectedTypes, type])
    : selectedTypes.filter((selected) => {
        return selected !== type;
      });
  if (nextTypes.length === 0) {
    return { mode: "all" };
  }
  return { mode: "selected", types: nextTypes };
}

function typeFilterLabel(typeFilter: NetworkLogTypeFilter): string {
  if (typeFilter.mode === "all") {
    return i18n.t(($) => {
      return $.activity.network.filter.allTypes;
    });
  }
  const selectedTypes = typeFilter.types;
  if (selectedTypes.length === 0) {
    return i18n.t(($) => {
      return $.activity.network.filter.allTypes;
    });
  }
  if (selectedTypes.length === 1) {
    return (
      selectedTypes[0] ??
      i18n.t(($) => {
        return $.activity.network.filter.allTypes;
      })
    );
  }
  return i18n.t(
    ($) => {
      return $.activity.network.filter.selectedTypes;
    },
    {
      count: selectedTypes.length,
      formattedCount: formatAppNumber(selectedTypes.length),
    },
  );
}

function TypeFilter({
  typeOptions,
  typeFilter,
  onChange,
}: {
  typeOptions: string[];
  typeFilter: NetworkLogTypeFilter;
  onChange: (filter: NetworkLogTypeFilter) => void;
}) {
  const { t } = useTranslation();
  const selectedTypes = selectedTypeValues(typeFilter, typeOptions);
  const selectedSet = new Set(selectedTypes);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t(($) => {
              return $.activity.network.filter.type;
            })}
            className="flex h-8 min-w-[140px] items-center justify-between gap-1.5 rounded-md border border-border bg-input px-3 text-xs text-foreground outline-none transition-colors hover:bg-input-hover focus:border-primary focus:ring-[3px] focus:ring-primary/10"
          />
        }
      >
        <span className="flex items-center gap-1.5">
          <Filter size={14} className="shrink-0" />
          {typeFilterLabel(typeFilter)}
        </span>
        <ChevronDown size={14} className="shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem
          closeOnClick={false}
          onClick={() => {
            onChange({ mode: "all" });
          }}
        >
          <span
            className="flex h-4 w-4 items-center justify-center"
            aria-hidden
          >
            {typeFilter.mode === "all" && <Check size={14} />}
          </span>
          {t(($) => {
            return $.activity.network.filter.allTypes;
          })}
        </DropdownMenuItem>
        {typeOptions.map((type) => {
          const selected = selectedSet.has(type);
          return (
            <DropdownMenuCheckboxItem
              key={type}
              checked={selected}
              closeOnClick={false}
              onCheckedChange={(checked) => {
                onChange(
                  setSelectedType(typeFilter, typeOptions, type, checked),
                );
              }}
            >
              <span className="flex h-4 w-4 items-center justify-center">
                <DropdownMenuCheckboxItemIndicator>
                  <Check size={14} />
                </DropdownMenuCheckboxItemIndicator>
              </span>
              {type}
            </DropdownMenuCheckboxItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "boolean") {
    return value
      ? i18n.t(($) => {
          return $.activity.network.yes;
        })
      : i18n.t(($) => {
          return $.activity.network.no;
        });
  }
  if (typeof value === "number") {
    return formatAppNumber(value, { useGrouping: false });
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatParams(params: Record<string, string> | undefined): string {
  if (!params) {
    return "—";
  }
  const filtered = Object.fromEntries(
    Object.entries(params).filter(([, v]) => {
      return v !== null && v !== undefined;
    }),
  );
  if (Object.keys(filtered).length === 0) {
    return "—";
  }
  return JSON.stringify(filtered);
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

type NetworkDetailLabelKey = keyof typeof enUSCommon.activity.network.details;

function localizeNetworkDetailLabel(labelKey: NetworkDetailLabelKey): string {
  return i18n.t(($) => {
    return $.activity.network.details[labelKey];
  });
}

function addField(
  out: [string, string][],
  label: string,
  raw: unknown,
  formatted: string,
): void {
  if (hasValue(raw)) {
    out.push([label, formatted]);
  }
}

// [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
// The exhaustive Record makes a new contract field fail type checking until
// the UI either adds a detail formatter or explicitly delegates it.
interface NetworkLogDetailDescriptor {
  readonly labelKey: NetworkDetailLabelKey;
  readonly value: (entry: NetworkLogEntry) => unknown;
  readonly format: (entry: NetworkLogEntry) => string;
}

function detailField<K extends keyof NetworkLogEntry>(
  labelKey: NetworkDetailLabelKey,
  key: K,
  formatter: (value: NetworkLogEntry[K]) => string = formatValue,
): NetworkLogDetailDescriptor {
  return {
    labelKey,
    value: (entry) => {
      return entry[key];
    },
    format: (entry) => {
      return formatter(entry[key]);
    },
  };
}

const networkLogDetailFields = {
  timestamp: detailField("timestamp", "timestamp"),
  type: detailField("type", "type"),
  action: detailField("action", "action"),
  method: detailField("method", "method"),
  url: detailField("url", "url"),
  // The URL cell already displays the omission sentinel.
  url_truncated: null,
  url_original_char_count: null,
  host: detailField("host", "host"),
  port: detailField("port", "port"),
  status: detailField("status", "status"),
  latency_ms: detailField("latency", "latency_ms", formatLatency),
  request_size: detailField("requestSize", "request_size", formatSize),
  response_size: detailField("responseSize", "response_size", formatSize),
  browser_user_agent: detailField("browserUserAgent", "browser_user_agent"),
  model_catalog_cache_status: detailField(
    "modelCatalogCacheStatus",
    "model_catalog_cache_status",
  ),
  model_catalog_cache_upstream_encoding: detailField(
    "modelCatalogUpstreamEncoding",
    "model_catalog_cache_upstream_encoding",
  ),
  model_catalog_cache_bypass_reason: detailField(
    "modelCatalogCacheBypassReason",
    "model_catalog_cache_bypass_reason",
  ),
  model_catalog_cache_entry_age_ms: detailField(
    "modelCatalogCacheEntryAge",
    "model_catalog_cache_entry_age_ms",
    formatLatency,
  ),
  model_catalog_cache_validation_latency_ms: detailField(
    "modelCatalogCacheValidationLatency",
    "model_catalog_cache_validation_latency_ms",
    formatLatency,
  ),
  model_catalog_cache_eviction_count: detailField(
    "modelCatalogCacheEvictionCount",
    "model_catalog_cache_eviction_count",
  ),
  model_catalog_prefetch_role: detailField(
    "modelCatalogPrefetchRole",
    "model_catalog_prefetch_role",
  ),
  dns_event: detailField("dnsEvent", "dns_event"),
  dns_query_type: detailField("dnsQueryType", "dns_query_type"),
  dns_result: detailField("dnsResult", "dns_result"),
  dns_serial: detailField("dnsSerial", "dns_serial"),
  firewall_name: detailField("firewall", "firewall_name"),
  firewall_permission: detailField("permission", "firewall_permission"),
  firewall_rule_match: detailField("ruleMatch", "firewall_rule_match"),
  firewall_base: detailField("baseUrl", "firewall_base"),
  firewall_params: detailField("params", "firewall_params", formatParams),
  firewall_billable: detailField("billable", "firewall_billable"),
  firewall_error: detailField("permissionError", "firewall_error"),
  upstream_binding_reason: detailField(
    "upstreamBindingReason",
    "upstream_binding_reason",
  ),
  upstream_binding_trusted_host: detailField(
    "upstreamBindingTrustedHost",
    "upstream_binding_trusted_host",
  ),
  upstream_binding_request_host: detailField(
    "upstreamBindingRequestHost",
    "upstream_binding_request_host",
  ),
  upstream_binding_request_port: detailField(
    "upstreamBindingRequestPort",
    "upstream_binding_request_port",
  ),
  upstream_binding_server_connected: detailField(
    "upstreamBindingServerConnected",
    "upstream_binding_server_connected",
  ),
  upstream_binding_server_address: detailField(
    "upstreamBindingServerAddress",
    "upstream_binding_server_address",
  ),
  upstream_binding_server_peername: detailField(
    "upstreamBindingServerPeername",
    "upstream_binding_server_peername",
  ),
  upstream_binding_server_sockname: detailField(
    "upstreamBindingServerSockname",
    "upstream_binding_server_sockname",
  ),
  upstream_binding_client_sockname: detailField(
    "upstreamBindingClientSockname",
    "upstream_binding_client_sockname",
  ),
  upstream_binding_server_id: detailField(
    "upstreamBindingServerId",
    "upstream_binding_server_id",
  ),
  upstream_binding_client_id: detailField(
    "upstreamBindingClientId",
    "upstream_binding_client_id",
  ),
  upstream_binding_direct_binding_present: detailField(
    "upstreamBindingDirectBindingPresent",
    "upstream_binding_direct_binding_present",
  ),
  upstream_binding_direct_binding_host: detailField(
    "upstreamBindingDirectBindingHost",
    "upstream_binding_direct_binding_host",
  ),
  upstream_binding_direct_binding_port: detailField(
    "upstreamBindingDirectBindingPort",
    "upstream_binding_direct_binding_port",
  ),
  upstream_binding_direct_binding_kinds: detailField(
    "upstreamBindingDirectBindingKinds",
    "upstream_binding_direct_binding_kinds",
  ),
  upstream_binding_client_binding_count: detailField(
    "upstreamBindingClientBindingCount",
    "upstream_binding_client_binding_count",
  ),
  upstream_binding_client_binding_match: detailField(
    "upstreamBindingClientBindingMatch",
    "upstream_binding_client_binding_match",
  ),
  upstream_binding_client_binding_endpoint_match: detailField(
    "upstreamBindingClientBindingEndpointMatch",
    "upstream_binding_client_binding_endpoint_match",
  ),
  upstream_binding_client_binding_hosts: detailField(
    "upstreamBindingClientBindingHosts",
    "upstream_binding_client_binding_hosts",
  ),
  connector_diagnostic_slug: detailField(
    "connectorDiagnostic",
    "connector_diagnostic_slug",
  ),
  connector_diagnostic_reason: detailField(
    "connectorReason",
    "connector_diagnostic_reason",
  ),
  connector_diagnostic_env_names: detailField(
    "connectorEnvNames",
    "connector_diagnostic_env_names",
  ),
  connector_diagnostic_base: detailField(
    "connectorBaseUrl",
    "connector_diagnostic_base",
  ),
  connector_route_reason: detailField(
    "connectorRouteReason",
    "connector_route_reason",
  ),
  connector_route_candidates: detailField(
    "connectorRouteCandidates",
    "connector_route_candidates",
  ),
  auth_resolved_secrets: detailField(
    "authResolvedSecrets",
    "auth_resolved_secrets",
  ),
  auth_refreshed_connectors: detailField(
    "authRefreshedConnectors",
    "auth_refreshed_connectors",
  ),
  auth_refreshed_secrets: detailField(
    "authRefreshedSecrets",
    "auth_refreshed_secrets",
  ),
  auth_cache_hit: detailField("authCacheHit", "auth_cache_hit"),
  auth_url_rewrite: detailField("authUrlRewrite", "auth_url_rewrite"),
  error: detailField("error", "error"),
  // CapturedBodySections renders these fields below the detail grid.
  request_headers: null,
  request_headers_truncated: null,
  request_body: null,
  request_body_encoding: null,
  request_body_truncated: null,
  response_headers: null,
  response_headers_truncated: null,
  response_body: null,
  response_body_encoding: null,
  response_body_truncated: null,
} satisfies Record<keyof NetworkLogEntry, NetworkLogDetailDescriptor | null>;

function collectDetails(entry: NetworkLogEntry): [string, string][] {
  const out: [string, string][] = [];
  for (const descriptor of Object.values(networkLogDetailFields)) {
    if (descriptor) {
      addField(
        out,
        localizeNetworkDetailLabel(descriptor.labelKey),
        descriptor.value(entry),
        descriptor.format(entry),
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detail row
// ---------------------------------------------------------------------------

function NetworkLogRowDetail({ entry }: { entry: NetworkLogEntry }) {
  const details = collectDetails(entry);

  if (details.length === 0) {
    return null;
  }

  return (
    <TableRow>
      <td colSpan={7} className="bg-muted/30 px-8 py-2">
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          {details.map(([label, value]) => {
            return (
              <div key={label} className="contents">
                <span className="text-muted-foreground font-medium">
                  {label}
                </span>
                <span className="font-mono break-all">{value}</span>
              </div>
            );
          })}
        </div>
        <CapturedBodySections entry={entry} />
      </td>
    </TableRow>
  );
}

function NetworkLogRow({
  entry,
  rowKey,
}: {
  entry: NetworkLogEntry;
  rowKey: string;
}) {
  const { t } = useTranslation();
  const expandedRows = useGet(networkLogExpandedRows$);
  const toggleExpanded = useSet(toggleNetworkLogRowExpanded$);
  const expanded = expandedRows.has(rowKey);
  const type = entryType(entry);
  const isHttp = type === "HTTP";

  const target = networkTarget(entry, isHttp);

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-state-hover"
        onClick={() => {
          toggleExpanded(rowKey);
        }}
      >
        <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
          {formatTime(entry.timestamp)}
        </TableCell>
        <TableCell>
          <TypeBadge type={type} action={entry.action} />
        </TableCell>
        <TableCell className="font-mono text-xs whitespace-nowrap">
          {isHttp ? (entry.method ?? "—") : "—"}
        </TableCell>
        <TableCell className="font-mono text-xs truncate max-w-[400px]">
          {target}
        </TableCell>
        <TableCell
          className={`font-mono text-xs whitespace-nowrap ${statusColor(entry.status)}`}
        >
          {entry.status ?? "—"}
        </TableCell>
        <TableCell
          className={`font-mono text-xs whitespace-nowrap ${latencyColor(entry.latency_ms)}`}
        >
          {formatLatency(entry.latency_ms)}
        </TableCell>
        <TableCell className="w-[160px] max-w-[160px]">
          <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs">
            {entry.firewall_name ? (
              <span className="min-w-0 max-w-full truncate text-cyan-600 dark:text-cyan-400">
                {entry.firewall_name}
              </span>
            ) : null}
            {entry.browser_user_agent ? (
              <span className="shrink-0 font-mono text-muted-foreground">
                {t(($) => {
                  return $.activity.network.browser;
                })}
              </span>
            ) : null}
          </div>
        </TableCell>
      </TableRow>
      {expanded && <NetworkLogRowDetail entry={entry} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// Exported content component
// ---------------------------------------------------------------------------

export function NetworkContent({
  networkLogs,
  hasMore,
  loading,
  onLoadMore,
}: {
  networkLogs: NetworkLogEntry[];
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
}) {
  const { t } = useTranslation();
  const typeFilter = useGet(networkLogTypeFilter$);
  const setTypeFilter = useSet(setNetworkLogTypeFilter$);
  const typeOptions = networkTypeOptions(networkLogs, typeFilter);
  const selectedTypes = selectedTypeValues(typeFilter, typeOptions);
  const selectedTypeSet = new Set(selectedTypes);
  const filteredNetworkLogs =
    typeFilter.mode === "all"
      ? networkLogs
      : networkLogs.filter((entry) => {
          return selectedTypeSet.has(entryType(entry));
        });

  return (
    <div className="pb-8">
      <div className="mb-3 flex justify-end">
        <TypeFilter
          typeOptions={typeOptions}
          typeFilter={typeFilter}
          onChange={setTypeFilter}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">
              {t(($) => {
                return $.activity.network.headers.time;
              })}
            </TableHead>
            <TableHead className="w-[60px]">
              {t(($) => {
                return $.activity.network.headers.type;
              })}
            </TableHead>
            <TableHead className="w-[60px]">
              {t(($) => {
                return $.activity.network.headers.method;
              })}
            </TableHead>
            <TableHead>
              {t(($) => {
                return $.activity.network.headers.urlHost;
              })}
            </TableHead>
            <TableHead className="w-[60px]">
              {t(($) => {
                return $.activity.network.headers.status;
              })}
            </TableHead>
            <TableHead className="w-[80px]">
              {t(($) => {
                return $.activity.network.headers.latency;
              })}
            </TableHead>
            <TableHead className="w-[160px]">
              {t(($) => {
                return $.activity.network.headers.permission;
              })}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {filteredNetworkLogs.length === 0 ? (
            <TableRow>
              <td
                colSpan={7}
                className="h-24 text-center text-sm text-muted-foreground"
              >
                {t(($) => {
                  return $.activity.network.noMatchingLogs;
                })}
              </td>
            </TableRow>
          ) : (
            filteredNetworkLogs.map((entry, idx) => {
              const key = `${entry.timestamp}-${entry.type}-${entry.host}-${entry.port}-${entry.url}-${idx}`;
              return <NetworkLogRow key={key} rowKey={key} entry={entry} />;
            })
          )}
        </TableBody>
      </Table>
      {hasMore && onLoadMore && (
        <div className="flex justify-center py-4">
          {loading ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <button
              type="button"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              onClick={onLoadMore}
            >
              {t(($) => {
                return $.activity.network.loadMore;
              })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
