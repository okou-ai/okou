"""Shared ``flow.metadata`` keys used across mitm addon modules.

This module is the public cross-module registry for metadata keys that flow
between mitmproxy hooks and addon packages. Hook-local private markers may
exist in their owning modules, but they are not part of this shared contract.
When adding a shared metadata key, add its ownership and lifecycle notes here.

Request context
---------------
- ``SANDBOX_RUN_ID``: ``str`` copied from registry sandbox info by HTTP request
  classification and ``tcp_start()``. Header-phase HTTP probes restore this key
  unless they intentionally keep the classification for a streaming or local
  response path. Read by HTTP, TCP, proxy logging, and usage reporting.
- ``SANDBOX_NETWORK_LOG_PATH``: ``str`` copied from registry sandbox info. Read by HTTP
  and TCP log writers; empty strings skip network-log writes.
- ``SANDBOX_PROXY_LOG_PATH``: ``str`` copied from registry sandbox info. Read by proxy
  warnings, usage reporting, and auth/streaming diagnostics.
- ``SANDBOX_AUTH_KEY``: ``str`` sandbox token copied from registry sandbox info.
  Read by usage webhook reporters.
- ``ORIGINAL_URL``: absolute URL written by HTTP request classification from
  trusted authority, or from the authority-validation fallback URL on local
  denial. Asterisk-form contributes an empty URL path while its raw ``*``
  target remains on the request and firewall decision. Read by response/error
  logging and connector billing.
- ``NETWORK_LOG_TARGET``: ``dict`` with ``url``, ``host``, and ``port`` from
  trusted authority or authority-validation fallback URL. Read by network-log
  entry construction.
- ``CAPTURE_BODY``: ``bool`` copied from registry sandbox info by HTTP request
  classification. Read by ``response()`` to decide whether to add
  request/response bodies.
- ``SUPPRESS_REQUEST_BODY_CAPTURE``: ``bool`` written by auth.base request-size
  handling. Read by body capture to mark oversized request bodies truncated.
- ``CLI_AGENT_TYPE``: ``str`` copied from validated registry sandbox info. Read by
  model-provider usage protocol selection.
- ``BROWSER_USER_AGENT``: ``bool`` written during request classification when
  the request matches the short-term browser passthrough User-Agent heuristic.
  Read by request dispatch to skip connector firewall handling and managed
  credential mutation, and by network-log entry construction.
- ``WEBSOCKET_UPGRADE_REQUEST``: ``bool`` written by request handling when the
  HTTP/1.1 request is a confirmed WebSocket upgrade handshake. Read by
  response streaming so only matching 101 responses defer model-provider usage
  release until ``websocket_end()``.
- ``RESPONSE_ENCODING_NEGOTIATION``: fixed ``str`` outcome written when request
  handling normalizes ``Accept-Encoding`` for response-body usage inspection.
  Read only by the fail-closed response-encoding diagnostic, restored with an
  abandoned header-phase request probe, preserved across firewall-auth
  revalidation, and removed by terminal flow cleanup.

Timing context
--------------
- ``HTTP_REQUEST_START_MONOTONIC``: ``float`` from ``time.monotonic()``,
  written when a request first reaches a registered-sandbox HTTP path, including
  header-phase streaming and local auth.base rejection paths. Popped by
  ``response()`` or ``error()`` when computing HTTP latency, and removed on
  request failures.
- ``TCP_START_MONOTONIC``: ``float`` from ``time.monotonic()``, written by
  ``tcp_start()``. Read by TCP end/error logging; it is not popped.

Firewall and auth context
-------------------------
- ``FIREWALL_BASE``: ``str`` matched firewall base. Written by firewall match,
  matched firewall block, and auth paths. Read by logging, auth cache
  invalidation, usage dispatch, and local error responses.
- ``FIREWALL_API_ID``: ``str`` API id or base fallback from the matched
  firewall. Read by auth handling.
- ``FIREWALL_AUTH_CACHE_KEY``: opaque typed auth cache key written by matched
  auth handling after the full auth input identity is known. Read by 401 cache
  invalidation; stores only a digest of auth inputs and sandbox token.
- ``FIREWALL_AUTH_CACHE_ENTRY_IDENTITY``: credential-free process-local object
  identifying the exact cached auth result applied to this flow. Written only
  after successful auth application and read by 401 cache invalidation.
- ``FIREWALL_NAME``: ``str`` firewall connector/model name. Read by logging,
  model-provider gates, and connector usage dispatch.
- ``FIREWALL_PERMISSION``: ``str`` matched permission name or empty string.
  Read by logging and connector-specific billing.
- ``FIREWALL_RULE_MATCH``: ``str`` matched rule or empty string. Read by
  network-log firewall metadata.
- ``FIREWALL_PARAMS``: ``dict`` firewall params from the match. Read by
  network-log firewall metadata when it has the expected shape.
- ``FIREWALL_BILLABLE``: ``bool`` computed from runner sandbox billable firewall
  context for matched auth flows, or forced ``False`` for browser passthrough
  and policy-only asterisk-form allows. Gates connector billing, model-provider
  billing and response parser setup.
- ``FIREWALL_ACTION``: ``str`` firewall decision such as ``ALLOW``, ``DENY``,
  or ``BLOCK``. Read by response/error network logging.
- ``FIREWALL_ERROR``: optional ``str`` error code for auth, forwarding, or
  registry failures. It is orthogonal to ``FIREWALL_ACTION``: an ``ALLOW``
  decision can still have an auth or forwarding error.
- ``CONNECTOR_DIAGNOSTIC_SLUG``: optional ``str`` connector slug stored under
  the canonical slug key for a generic connector availability diagnostic.
  Ordinary allowed requests retain private eligibility and catalog lookup
  context without setting this key. ``connector_diagnostics`` writes it when
  creating a local shared-base 424 in ``requestheaders()`` or ``request()``, or
  replacing an eligible upstream 401/403 in ``responseheaders()`` or
  ``response()``. Connection-error handling only finalizes an already-installed
  response-header diagnostic; it does not create one from pending lookup
  context. Network logs copy the public diagnostic fields when present.
- ``CONNECTOR_DIAGNOSTIC_REASON``: optional ``str`` generic diagnostic reason.
  First-version diagnostics use ``not_configured_for_run``.
- ``CONNECTOR_DIAGNOSTIC_ENV_NAMES``: optional ``list[str]`` env aliases that
  would normally expose connector credentials. Names only; never values.
- ``CONNECTOR_DIAGNOSTIC_BASE``: optional ``str`` matched static built-in base
  URL that produced the diagnostic.
- ``CONNECTOR_ROUTE_REASON``: optional ``str`` connector-route ambiguity reason.
- ``CONNECTOR_ROUTE_CANDIDATES``: optional ``list[str]`` of config-derived
  connector owners for an ambiguous route. Never contains the supplied hint.
- ``AUTH_RESOLVED_SECRETS``: ``list[str]`` from successful auth resolution.
  Read by network-log firewall metadata.
- ``AUTH_REFRESHED_CONNECTORS``: ``list[str]`` from successful auth resolution.
  Read by network-log firewall metadata.
- ``AUTH_REFRESHED_SECRETS``: ``list[str]`` from successful auth resolution.
  Read by network-log firewall metadata.
- ``AUTH_CACHE_HIT``: ``bool`` from successful auth resolution. Read by
  network-log firewall metadata.
- ``AUTH_URL_REWRITE``: ``bool`` written only after inline auth.base forwarding
  succeeds and sets the provider response on the flow. Read by network-log
  firewall metadata.
- ``AUTH_BASE_FORWARD_ADMISSION``: opaque auth.base forwarding admission
  reservation written by header-phase auth.base admission and consumed by the
  request auth.base forwarder path. Released by request/terminal cleanup if it
  is not transferred to the forwarder.
- ``AWS_SIGV4_BODY_ADMISSION``: opaque aggregate reservation for a buffered
  body-dependent SigV4 request. Written before body buffering and released by
  terminal flow cleanup.
- ``AWS_SIGV4_REQUEST_INSPECTION``: opaque bounded request-representation
  inspection written by managed SigV4 auth. Reused by request-header and request
  auth phases while the raw URL/header identity is unchanged, restored with an
  abandoned header probe, consumed after signing, and removed by request or
  terminal cleanup when signing does not consume it.
- ``TRUSTED_AUTHORITY_HOST``: ``str`` host from authority validation. Read by
  auth-base URL rewrite logic when reconstructing trusted request authority.

Response streaming
------------------
- ``RESPONSE_STREAM_STATE``: ``dict`` containing ``total_bytes`` for the
  general response stream callback. Read for exact response-size logging and
  removed by stream cleanup.
- ``STREAM_BUFFER``: capped ``bytearray`` written by ``responseheaders()`` via
  response streaming setup only when body capture or bounded terminal
  inspection needs raw response bytes. Read by body capture, model JSON usage
  and failure inspection, and connector fallback parsing. Removed by stream
  cleanup after terminal hooks.
- ``STREAM_BUFFER_STATE``: ``dict`` containing ``truncated``. Written only
  with ``STREAM_BUFFER`` and read for capture truncation, model JSON terminal
  inspection, and connector fallback parsing. Removed by stream cleanup.

Request streaming
-----------------
- ``REQUEST_STREAM_BUFFER``: capped ``bytearray`` written by
  ``requestheaders()`` only when this module installs its callback with body
  capture enabled. A setup attempt that finds an externally owned callable does
  not create this buffer; repeated addon setup preserves the existing buffer. Read
  by request body capture and connector billing refinement. Removed by stream
  cleanup after terminal hooks.
- ``REQUEST_STREAM_BUFFER_STATE``: ``dict`` with at least ``truncated`` and
  ``total_bytes``. Written only when this module installs its callback and read
  for request size. A setup attempt that finds an externally owned callable does
  not create this state; repeated addon setup preserves existing state.
  Capture-enabled paths also write ``REQUEST_STREAM_BUFFER`` and use this state
  for capture truncation and connector billing refinement. Removed by stream
  cleanup.
- ``REQUEST_STREAM_COMPLETE``: ``bool`` written by ``request()`` after
  mitmproxy finishes delivering a request whose stream size is tracked by this
  module. The external-callable no-op path provides no addon stream state from
  which to establish this marker. Read by connector billing before treating a
  non-truncated request stream buffer as a complete request body. Removed by
  stream cleanup.

Model-provider usage
--------------------
- ``MODEL_PROVIDER_USAGE``: ``dict`` of normalized token usage for one
  flow-level model response source. Written by HTTP SSE/JSON inspectors or
  WebSocket extraction, then read by the model usage-event reporter.
- ``MODEL_PROVIDER_USAGE_SOURCES``: ``dict`` keyed by WebSocket response id,
  with normalized token usage dict values. Written by WebSocket model-provider
  usage extraction and read by the model usage-event reporter.
  Entries are released before ``websocket_end()`` after each source-preserving
  report attempt. Zero-only entries are also released immediately.
- ``MODEL_PROVIDER_USAGE_TIERS``: bounded insertion-ordered mapping from
  WebSocket response id to the concrete billing tier decision selected from
  its input partition. Zero-only decisions remain provisional until the first
  positive billing item. Evicted decisions can be recovered while their
  concrete source keys remain in the separately bounded usage admission
  history; otherwise positive usage uses a conservative tier. Written by
  model-provider billing and cleared at the WebSocket terminal lifecycle
  boundary.
- ``MODEL_USAGE_PROVIDER``: optional ``str`` canonical model id from registry sandbox
  info. Read by model-provider reported-model selection.
Connector usage and parser state
--------------------------------
- ``X_NDJSON_STATE``: ``dict`` owned by the X connector NDJSON parser. Written
  when a streaming X response parser is registered and read by X billing.
- ``X_JSON_STATE``: ``dict`` owned by the X connector JSON parser. Written by
  connector parser finalization before normal response billing, then read by X
  billing instead of the capped stream-buffer fallback.
"""

from typing import Final

# Run and request context
SANDBOX_RUN_ID: Final = "sandbox_run_id"
SANDBOX_NETWORK_LOG_PATH: Final = "sandbox_network_log_path"
SANDBOX_PROXY_LOG_PATH: Final = "sandbox_proxy_log_path"
SANDBOX_AUTH_KEY: Final = "sandbox_token"
ORIGINAL_URL: Final = "original_url"
NETWORK_LOG_TARGET: Final = "network_log_target"
CAPTURE_BODY: Final = "capture_body"
SUPPRESS_REQUEST_BODY_CAPTURE: Final = "suppress_request_body_capture"
CLI_AGENT_TYPE: Final = "cli_agent_type"
BROWSER_USER_AGENT: Final = "browser_user_agent"
WEBSOCKET_UPGRADE_REQUEST: Final = "websocket_upgrade_request"
RESPONSE_ENCODING_NEGOTIATION: Final = "response_encoding_negotiation"

# Timing metadata
HTTP_REQUEST_START_MONOTONIC: Final = "http_request_start_monotonic"
TCP_START_MONOTONIC: Final = "tcp_start_monotonic"

# Firewall and auth metadata
FIREWALL_BASE: Final = "firewall_base"
FIREWALL_API_ID: Final = "firewall_api_id"
FIREWALL_AUTH_CACHE_KEY: Final = "firewall_auth_cache_key"
FIREWALL_AUTH_CACHE_ENTRY_IDENTITY: Final = "firewall_auth_cache_entry_identity"
FIREWALL_NAME: Final = "firewall_name"
FIREWALL_PERMISSION: Final = "firewall_permission"
FIREWALL_RULE_MATCH: Final = "firewall_rule_match"
FIREWALL_PARAMS: Final = "firewall_params"
FIREWALL_BILLABLE: Final = "firewall_billable"
FIREWALL_ACTION: Final = "firewall_action"
FIREWALL_ERROR: Final = "firewall_error"
CONNECTOR_DIAGNOSTIC_SLUG: Final = "connector_diagnostic_slug"
CONNECTOR_DIAGNOSTIC_REASON: Final = "connector_diagnostic_reason"
CONNECTOR_DIAGNOSTIC_ENV_NAMES: Final = "connector_diagnostic_env_names"
CONNECTOR_DIAGNOSTIC_BASE: Final = "connector_diagnostic_base"
CONNECTOR_ROUTE_REASON: Final = "connector_route_reason"
CONNECTOR_ROUTE_CANDIDATES: Final = "connector_route_candidates"
AUTH_RESOLVED_SECRETS: Final = "auth_resolved_secrets"
AUTH_REFRESHED_CONNECTORS: Final = "auth_refreshed_connectors"
AUTH_REFRESHED_SECRETS: Final = "auth_refreshed_secrets"
AUTH_CACHE_HIT: Final = "auth_cache_hit"
AUTH_URL_REWRITE: Final = "auth_url_rewrite"
AUTH_BASE_FORWARD_ADMISSION: Final = "auth_base_forward_admission"
AWS_SIGV4_BODY_ADMISSION: Final = "aws_sigv4_body_admission"
AWS_SIGV4_REQUEST_INSPECTION: Final = "aws_sigv4_request_inspection"
TRUSTED_AUTHORITY_HOST: Final = "trusted_authority_host"

# Usage and streaming metadata
MODEL_PROVIDER_USAGE: Final = "model_provider_usage"
MODEL_PROVIDER_USAGE_SOURCES: Final = "model_provider_usage_sources"
MODEL_PROVIDER_USAGE_TIERS: Final = "model_provider_usage_tiers"
MODEL_USAGE_PROVIDER: Final = "model_usage_provider"
X_RESOURCE_BILLING: Final = "x_resource_billing"
X_RESOURCE_STREAM_REPORTED: Final = "x_resource_stream_reported"
X_RESOURCE_REMAINDER: Final = "x_resource_remainder"
X_RESOURCE_REPORTED: Final = "x_resource_reported"
RESPONSE_STREAM_STATE: Final = "response_stream_state"
STREAM_BUFFER: Final = "stream_buffer"
STREAM_BUFFER_STATE: Final = "stream_buffer_state"
REQUEST_STREAM_BUFFER: Final = "request_stream_buffer"
REQUEST_STREAM_BUFFER_STATE: Final = "request_stream_buffer_state"
REQUEST_STREAM_COMPLETE: Final = "request_stream_complete"
X_NDJSON_STATE: Final = "x_ndjson_state"
X_JSON_STATE: Final = "x_json_state"
