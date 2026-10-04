import {
  modelCatalogCacheBypassReasonSchema,
  modelCatalogCacheEvictionCountSchema,
  modelCatalogCacheMillisecondsSchema,
  modelCatalogCacheStatusSchema,
  modelCatalogCacheUpstreamEncodingSchema,
  modelCatalogPrefetchRoleSchema,
  networkLogActionSchema,
  networkLogEntrySchema,
  type NetworkLogEntry,
} from "@okouai/api-contracts/contracts/runs";

type UnknownRecord = Record<string, unknown>;
type UpstreamBindingField = Extract<
  keyof NetworkLogEntry,
  `upstream_binding_${string}`
>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((item): item is string => {
    return typeof item === "string";
  });
  return strings.length === value.length ? strings : undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    },
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function networkActionValue(
  value: unknown,
): NetworkLogEntry["action"] | undefined {
  const parsed = networkLogActionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function modelCatalogCacheStatusValue(
  value: unknown,
): NetworkLogEntry["model_catalog_cache_status"] | undefined {
  const parsed = modelCatalogCacheStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function modelCatalogCacheBypassReasonValue(
  value: unknown,
): NetworkLogEntry["model_catalog_cache_bypass_reason"] | undefined {
  const parsed = modelCatalogCacheBypassReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function modelCatalogCacheUpstreamEncodingValue(
  value: unknown,
): NetworkLogEntry["model_catalog_cache_upstream_encoding"] | undefined {
  const parsed = modelCatalogCacheUpstreamEncodingSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function modelCatalogPrefetchRoleValue(
  value: unknown,
): NetworkLogEntry["model_catalog_prefetch_role"] | undefined {
  const parsed = modelCatalogPrefetchRoleSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function modelCatalogCacheMillisecondsValue(
  value: unknown,
): number | undefined {
  const parsed = modelCatalogCacheMillisecondsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function modelCatalogCacheEvictionCountValue(
  value: unknown,
): number | undefined {
  const parsed = modelCatalogCacheEvictionCountSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function networkBodyEncodingValue(value: unknown): string | undefined {
  const isUtf8 =
    typeof value === "string" &&
    value.length === 5 &&
    value.slice(0, 3) === "utf" &&
    value[3] === "-" &&
    value[4] === "8";
  if (isUtf8 || value === "base64" || value === "binary") {
    return value;
  }
  return undefined;
}

function omitUndefined(record: UnknownRecord): UnknownRecord {
  return Object.fromEntries(
    Object.entries(record).filter((entry) => {
      return entry[1] !== undefined;
    }),
  );
}

function sanitizeUpstreamBindingFields(
  event: UnknownRecord,
): Record<UpstreamBindingField, unknown> {
  return {
    upstream_binding_reason: stringValue(event.upstream_binding_reason),
    upstream_binding_trusted_host: stringValue(
      event.upstream_binding_trusted_host,
    ),
    upstream_binding_request_host: stringValue(
      event.upstream_binding_request_host,
    ),
    upstream_binding_request_port: numberValue(
      event.upstream_binding_request_port,
    ),
    upstream_binding_server_connected: booleanValue(
      event.upstream_binding_server_connected,
    ),
    upstream_binding_server_address: stringValue(
      event.upstream_binding_server_address,
    ),
    upstream_binding_server_peername: stringValue(
      event.upstream_binding_server_peername,
    ),
    upstream_binding_server_sockname: stringValue(
      event.upstream_binding_server_sockname,
    ),
    upstream_binding_client_sockname: stringValue(
      event.upstream_binding_client_sockname,
    ),
    upstream_binding_server_id: stringValue(event.upstream_binding_server_id),
    upstream_binding_client_id: stringValue(event.upstream_binding_client_id),
    upstream_binding_direct_binding_present: booleanValue(
      event.upstream_binding_direct_binding_present,
    ),
    upstream_binding_direct_binding_host: stringValue(
      event.upstream_binding_direct_binding_host,
    ),
    upstream_binding_direct_binding_port: numberValue(
      event.upstream_binding_direct_binding_port,
    ),
    upstream_binding_direct_binding_kinds: stringValue(
      event.upstream_binding_direct_binding_kinds,
    ),
    upstream_binding_client_binding_count: numberValue(
      event.upstream_binding_client_binding_count,
    ),
    upstream_binding_client_binding_match: booleanValue(
      event.upstream_binding_client_binding_match,
    ),
    upstream_binding_client_binding_endpoint_match: booleanValue(
      event.upstream_binding_client_binding_endpoint_match,
    ),
    upstream_binding_client_binding_hosts: stringValue(
      event.upstream_binding_client_binding_hosts,
    ),
  };
}

function sanitizeAxiomNetworkEvent(event: unknown): NetworkLogEntry | null {
  if (!isRecord(event)) {
    return null;
  }

  const timestamp = stringValue(event._time);
  if (timestamp === undefined) {
    return null;
  }

  // [NETWORK_LOG_FIELDS] — keep this projection exhaustive against the
  // shared contract so API reads cannot silently drop producer fields.
  const candidate = omitUndefined({
    timestamp,
    type: stringValue(event.type),
    action: networkActionValue(event.action),
    host: stringValue(event.host),
    port: numberValue(event.port),
    method: stringValue(event.method),
    url: stringValue(event.url),
    url_truncated: booleanValue(event.url_truncated),
    url_original_char_count: numberValue(event.url_original_char_count),
    status: numberValue(event.status),
    latency_ms: numberValue(event.latency_ms),
    request_size: numberValue(event.request_size),
    response_size: numberValue(event.response_size),
    browser_user_agent: booleanValue(event.browser_user_agent),
    model_catalog_cache_status: modelCatalogCacheStatusValue(
      event.model_catalog_cache_status,
    ),
    model_catalog_cache_upstream_encoding:
      modelCatalogCacheUpstreamEncodingValue(
        event.model_catalog_cache_upstream_encoding,
      ),
    model_catalog_cache_bypass_reason: modelCatalogCacheBypassReasonValue(
      event.model_catalog_cache_bypass_reason,
    ),
    model_catalog_cache_entry_age_ms: modelCatalogCacheMillisecondsValue(
      event.model_catalog_cache_entry_age_ms,
    ),
    model_catalog_cache_validation_latency_ms:
      modelCatalogCacheMillisecondsValue(
        event.model_catalog_cache_validation_latency_ms,
      ),
    model_catalog_cache_eviction_count: modelCatalogCacheEvictionCountValue(
      event.model_catalog_cache_eviction_count,
    ),
    model_catalog_prefetch_role: modelCatalogPrefetchRoleValue(
      event.model_catalog_prefetch_role,
    ),
    dns_event: stringValue(event.dns_event),
    dns_query_type: stringValue(event.dns_query_type),
    dns_result: stringValue(event.dns_result),
    dns_serial: stringValue(event.dns_serial),
    firewall_base: stringValue(event.firewall_base),
    firewall_name: stringValue(event.firewall_name),
    firewall_permission: stringValue(event.firewall_permission),
    firewall_rule_match: stringValue(event.firewall_rule_match),
    firewall_params: stringRecordValue(event.firewall_params),
    firewall_billable: booleanValue(event.firewall_billable),
    firewall_error: stringValue(event.firewall_error),
    ...sanitizeUpstreamBindingFields(event),
    connector_diagnostic_slug: stringValue(event.connector_diagnostic_slug),
    connector_diagnostic_reason: stringValue(event.connector_diagnostic_reason),
    connector_diagnostic_env_names: stringArrayValue(
      event.connector_diagnostic_env_names,
    ),
    connector_diagnostic_base: stringValue(event.connector_diagnostic_base),
    connector_route_reason: stringValue(event.connector_route_reason),
    connector_route_candidates: stringArrayValue(
      event.connector_route_candidates,
    ),
    auth_resolved_secrets: stringArrayValue(event.auth_resolved_secrets),
    auth_refreshed_connectors: stringArrayValue(
      event.auth_refreshed_connectors,
    ),
    auth_refreshed_secrets: stringArrayValue(event.auth_refreshed_secrets),
    auth_cache_hit: booleanValue(event.auth_cache_hit),
    auth_url_rewrite: booleanValue(event.auth_url_rewrite),
    error: stringValue(event.error),
    request_headers: stringRecordValue(event.request_headers),
    request_headers_truncated: booleanValue(event.request_headers_truncated),
    request_body: stringValue(event.request_body),
    request_body_encoding: networkBodyEncodingValue(
      event.request_body_encoding,
    ),
    request_body_truncated: booleanValue(event.request_body_truncated),
    response_headers: stringRecordValue(event.response_headers),
    response_headers_truncated: booleanValue(event.response_headers_truncated),
    response_body: stringValue(event.response_body),
    response_body_encoding: networkBodyEncodingValue(
      event.response_body_encoding,
    ),
    response_body_truncated: booleanValue(event.response_body_truncated),
  } satisfies Record<keyof NetworkLogEntry, unknown>);

  const parsed = networkLogEntrySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function sanitizeAxiomNetworkEvents(
  events: readonly unknown[],
): NetworkLogEntry[] {
  return events.flatMap((event) => {
    const networkLog = sanitizeAxiomNetworkEvent(event);
    return networkLog ? [networkLog] : [];
  });
}
