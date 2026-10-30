import {
  array,
  boolean,
  number,
  object,
  record,
  string,
  enum as zEnum,
} from "zod";
import { orgTierSchema } from "../contracts/orgs";

/**
 * Network log action semantics:
 * ALLOW means the request was allowed to continue.
 * DENY means network policy denied the request.
 * BLOCK means platform/proxy/auth/preconditions blocked the request locally.
 */
export const networkLogActionSchema = zEnum(["ALLOW", "DENY", "BLOCK"]);

export const modelCatalogCacheStatusSchema = zEnum([
  "model_catalog_bypass",
  "model_catalog_fresh_hit",
  "model_catalog_cold_stored",
  "model_catalog_cold_not_stored",
  "model_catalog_revalidated_304",
  "model_catalog_revalidated_200_same",
  "model_catalog_revalidated_200_changed",
  "model_catalog_revalidation_not_stored",
  "model_catalog_etag_confirmed",
  "model_catalog_etag_invalidated",
]);

export const modelCatalogCacheBypassReasonSchema = zEnum([
  "request_url",
  "request_method",
  "request_framing",
  "request_body",
  "request_streaming",
  "request_conditions",
  "request_cache_control",
  "request_encoding",
  "request_identity",
  "request_capacity",
  "response_status",
  "response_encoding",
  "response_content_type",
  "response_cache_control",
  "response_vary",
  "response_etag",
  "response_size",
  "response_stream",
  "response_body",
  "response_json",
  "response_shape",
  "response_missing",
  "concurrent_change",
  "transport_error",
]);

const modelCatalogCacheUpstreamEncodingSchema = zEnum(["identity", "br"]);

export const modelCatalogPrefetchRoleSchema = zEnum([
  "producer",
  "completed_consumer",
  "inflight_consumer",
]);

export const modelCatalogCacheMillisecondsSchema = number()
  .int()
  .min(0)
  .max(2_147_483_647);

const modelCatalogCacheEvictionCountSchema = number().int().min(0).max(32);

/**
 * Network log entry schema.
 * [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
 */
export const networkLogEntrySchema = object({
  timestamp: string(),
  type: string().optional(),
  action: networkLogActionSchema.optional(),
  host: string().optional(),
  port: number().optional(),
  method: string().optional(),
  url: string().optional(),
  url_truncated: boolean().optional(),
  url_original_char_count: number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  status: number().optional(),
  latency_ms: number().optional(),
  request_size: number().optional(),
  response_size: number().optional(),
  browser_user_agent: boolean().optional(),
  model_catalog_cache_status: modelCatalogCacheStatusSchema.optional(),
  model_catalog_cache_upstream_encoding:
    modelCatalogCacheUpstreamEncodingSchema.optional(),
  model_catalog_cache_bypass_reason:
    modelCatalogCacheBypassReasonSchema.optional(),
  model_catalog_cache_entry_age_ms:
    modelCatalogCacheMillisecondsSchema.optional(),
  model_catalog_cache_validation_latency_ms:
    modelCatalogCacheMillisecondsSchema.optional(),
  model_catalog_cache_eviction_count:
    modelCatalogCacheEvictionCountSchema.optional(),
  model_catalog_prefetch_role: modelCatalogPrefetchRoleSchema.optional(),
  dns_event: string().optional(),
  dns_query_type: string().optional(),
  dns_result: string().optional(),
  dns_serial: string().optional(),
  firewall_base: string().optional(),
  firewall_name: string().optional(),
  firewall_permission: string().optional(),
  firewall_rule_match: string().optional(),
  firewall_params: record(string(), string()).optional(),
  firewall_billable: boolean().optional(),
  firewall_error: string().optional(),
  upstream_binding_reason: string().optional(),
  upstream_binding_trusted_host: string().optional(),
  upstream_binding_request_host: string().optional(),
  upstream_binding_request_port: number().optional(),
  upstream_binding_server_connected: boolean().optional(),
  upstream_binding_server_address: string().optional(),
  upstream_binding_server_peername: string().optional(),
  upstream_binding_server_sockname: string().optional(),
  upstream_binding_client_sockname: string().optional(),
  upstream_binding_server_id: string().optional(),
  upstream_binding_client_id: string().optional(),
  upstream_binding_direct_binding_present: boolean().optional(),
  upstream_binding_direct_binding_host: string().optional(),
  upstream_binding_direct_binding_port: number().optional(),
  upstream_binding_direct_binding_kinds: string().optional(),
  upstream_binding_client_binding_count: number().optional(),
  upstream_binding_client_binding_match: boolean().optional(),
  upstream_binding_client_binding_endpoint_match: boolean().optional(),
  upstream_binding_client_binding_hosts: string().optional(),
  connector_diagnostic_slug: string().optional(),
  connector_diagnostic_reason: string().optional(),
  connector_diagnostic_env_names: array(string()).optional(),
  connector_diagnostic_base: string().optional(),
  connector_route_reason: string().optional(),
  connector_route_candidates: array(string()).optional(),
  auth_resolved_secrets: array(string()).optional(),
  auth_refreshed_connectors: array(string()).optional(),
  auth_refreshed_secrets: array(string()).optional(),
  auth_cache_hit: boolean().optional(),
  auth_url_rewrite: boolean().optional(),
  error: string().optional(),
  // Capture-only fields (opt-in via captureNetworkBodies). Header maps are
  // default-redacted, sanitized, and independently bounded to 512 fields / 32
  // KiB; see crates/runner/mitm-addon/src/body_capture.py for the contract.
  // *_headers_truncated describes only an incomplete serialized header map.
  // Body strings are bounded capture results; *_body_encoding distinguishes
  // UTF-8, base64, and binary outcomes, while *_body_truncated describes an
  // incomplete or suppressed capture. Empty bodies have no body or encoding.
  request_headers: record(string(), string()).optional(),
  request_headers_truncated: boolean().optional(),
  request_body: string().optional(),
  request_body_encoding: zEnum(["utf-8", "base64", "binary"]).optional(),
  request_body_truncated: boolean().optional(),
  response_headers: record(string(), string()).optional(),
  response_headers_truncated: boolean().optional(),
  response_body: string().optional(),
  response_body_encoding: zEnum(["utf-8", "base64", "binary"]).optional(),
  response_body_truncated: boolean().optional(),
});

/**
 * Running task schema — shows currently executing runs
 */
export const runningTaskSchema = object({
  runId: string().nullable(),
  agentName: string(),
  agentDisplayName: string().nullable(),
  userEmail: string(),
  startedAt: string().nullable(),
  isOwner: boolean(),
});

/**
 * Concurrency info schema
 */
export const concurrencyMemberUsageSchema = object({
  userId: string(),
  displayName: string(),
  active: number(),
});

export const concurrencyInfoSchema = object({
  tier: orgTierSchema,
  limit: number(),
  active: number(),
  available: number(),
  memberUsage: array(concurrencyMemberUsageSchema),
});

/**
 * Queue response schema
 */
export const queueResponseSchema = object({
  concurrency: concurrencyInfoSchema,
  runningTasks: array(runningTaskSchema),
});

export {
  modelCatalogCacheUpstreamEncodingSchema,
  modelCatalogCacheEvictionCountSchema,
};
