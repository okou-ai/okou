# mitmproxy Addon Testing Guide

## Overview

The mitmproxy addon (`crates/runner/mitm-addon/`) is a Python module that intercepts HTTPS requests inside sandboxes. Tests live in `tests/` and use pytest.

## Runtime Contracts

Read [addon runtime contracts](../mitm-addon-contracts.md) when changing control, logging,
WebSocket framing or handshake inspection, path normalization, or dependency
pins. That reference owns limits, redaction, failure handling, and rollout
boundaries; the tests below exercise those contracts.

## Environment Setup

The addon uses uv for dependency management. The supported devcontainer installs
the exact uv version declared in `pyproject.toml`. In other environments, install
that version before continuing:

```bash
cd crates/runner/mitm-addon
UV_VERSION="$(
  python3 -c 'import tomllib; print(tomllib.load(open("pyproject.toml", "rb"))["tool"]["uv"]["required-version"].removeprefix("=="))'
)"
curl --proto '=https' --tlsv1.2 -LsSf \
  "https://astral.sh/uv/$UV_VERSION/install.sh" |
  env UV_UNMANAGED_INSTALL="$HOME/.local/bin" sh
export PATH="$HOME/.local/bin:$PATH"
uv --version
```

Create or update the local environment from the committed lockfile:

```bash
cd crates/runner/mitm-addon
uv lock --check
uv sync --locked
```

`uv sync --locked` installs the development and test dependency groups into
`.venv` without changing `uv.lock`. It also selects the exact interpreter from
`.python-version`, which matches the Python patch embedded in the pinned
mitmproxy standalone runtime. The package metadata, Ruff, and BasedPyright
retain Python 3.12 as the supported source-compatibility floor.

## Running Tests

```bash
cd crates/runner/mitm-addon

# All tests
uv run --no-sync python -m pytest tests/

# Specific file
uv run --no-sync python -m pytest tests/test_request_handler_passthrough.py

# Specific test
uv run --no-sync python -m pytest \
  tests/test_request_handler_passthrough.py::test_allowed_domain_passes_through

# Verbose
uv run --no-sync python -m pytest -v tests/
```

Run auth.base forwarder contracts independently when working on one ownership
area:

```bash
uv run --no-sync python -m pytest tests/test_auth_base_forwarder_security.py
uv run --no-sync python -m pytest tests/test_auth_base_forwarder_protocol.py
uv run --no-sync python -m pytest tests/test_auth_base_forwarder_lifecycle.py
```

Run the same static checks used by CI:

```bash
uv run --no-sync ruff format --check .
uv run --no-sync ruff check .
uv run --no-sync basedpyright -p .
```

### Private control and packaged runtime

`test_runner_control.py` exercises real Unix sockets: strict framing, correlation,
bounded admission, partial peers, exclusive bind, long paths, shutdown, and
generation changes. `test_addon_configuration.py` verifies JSONL initialization
precedes control readiness. Rust's `proxy::control` and `proxy::process` tests
cover bounded clients plus startup/restart/cleanup with the embedded Python server.

Run the standalone-artifact suite from the repository root:

```bash
bash .github/scripts/check-packaged-addon-control.sh
```

The wrapper selects the native supported architecture through the shared Runner
target helper, downloads the mitmproxy version pinned in `deps.rs`, verifies both
archive and executable size/SHA-256, and invokes `tests/packaged_control.py`.
That explicitly selected suite fails if its verified executable is absent; normal
pytest discovery does not download binaries. It loads the production addon with
fixture-owned configuration, checks socket and TCP readiness, stops it, and starts
a fresh generation without contacting platform or model APIs. It also generates
a network record through a real firewall-denied HTTP request, unregisters the
sandbox, and verifies `logs.flush` and the original log bytes. CI runs it on both
x86_64 and aarch64 and includes it in the Crates gate.

### Flow metadata key contract check

Run the flow metadata key linter when adding or renaming shared metadata keys,
and before committing related addon changes:

```bash
cd crates/runner/mitm-addon
./scripts/check-flow-metadata-keys.py
```

A clean run exits 0 without output. An exit code of 1 prints duplicate
registered metadata-key values or repository key-use diagnostics. The linter
recursively scans Python files under `src/` and `tests/`, excludes the
canonical [`src/flow_metadata_keys.py`](../../crates/runner/mitm-addon/src/flow_metadata_keys.py)
registry, and does not inspect `scripts/`. Use the registry's `metadata_keys`
constants instead of literal shared metadata keys.

Pre-commit hooks verify the lockfile when dependency metadata changes and run
Ruff from the locked environment for staged addon Python files. Run pytest
manually before committing behavior changes.

## Updating Dependencies

Edit the dependency constraints in `pyproject.toml`, then regenerate and verify
the lockfile:

```bash
uv lock
uv sync --locked
uv lock --check
```

To deliberately refresh every dependency, use `uv lock --upgrade`. To refresh
one package and the portion of the graph it constrains, use
`uv lock --upgrade-package <package>`. Review the resolved versions and hashes
with `git diff -- uv.lock`, then run all static checks and the complete test
suite.

Commit `pyproject.toml` and `uv.lock` together. The contract test in
`crates/runner/src/deps.rs` requires the mitmproxy constraint and add-on runtime
guard to match the canonical standalone runtime version.

Before changing that version, re-audit the private mitmproxy APIs used by the
compatibility layer. Update the canonical Rust version together with the
x86_64 and aarch64 installed/archive sizes and checksums, then update the Python
constraint and lockfile. Run both the runner and complete add-on validation
suites before committing the upgrade.

## Test Files

| File                                                    | Tests                                                                                                                |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `test_addon_configuration.py`                           | Addon option registration and configuration updates                                                                  |
| `test_addon_process_logging.py`                         | Bounded versioned addon process events written to Runner-owned stderr                                                |
| `test_builtin_host_policy_contract.py`                  | Cross-stage malformed built-in host policy contracts                                                                 |
| `test_connection_endpoints.py`                          | Connection endpoint shape validation and IPv6 tuple normalization                                                    |
| `test_content_length.py`                                | Shared bounded Content-Length field parsing contract                                                                 |
| `buffered_auth_body_framing_cases.py`                   | Shared rejected framing cases for auth.base and AWS SigV4 request integration tests                                  |
| `codex_model_catalog_cache_helpers.py`                  | Shared Codex catalog flow, response, and cache lifecycle test builders                                               |
| `test_codex_model_catalog_cache_coordination.py`        | Codex catalog prefetch, single-flight, wait, cancellation, and active-request capacity behavior                      |
| `test_codex_model_catalog_cache_hooks.py`               | Codex catalog request admission, firewall hook integration, telemetry, and cleanup                                   |
| `test_codex_model_catalog_cache_lifecycle.py`           | Codex catalog partitioning, expiry, ETag invalidation, and stored-entry eviction                                     |
| `test_codex_model_catalog_cache_responses.py`           | Codex catalog response cacheability, decoding, framing, validation, and replay                                       |
| `test_request_handler_passthrough.py`                   | Request-hook ordinary and browser user-agent passthrough decisions                                                   |
| `test_request_handler_authority_validation.py`          | Request-hook SNI and asserted HTTP authority validation and denial effects                                           |
| `test_request_handler_builtin_host_policy.py`           | Request-hook runtime built-in host-policy enforcement and compiled-policy reuse                                      |
| `test_request_handler_connector_admission.py`           | Request-hook connector destination admission, TLS evidence, test-endpoint bypass, and API binding interaction        |
| `test_request_handler_api_admission.py`                 | Request-hook platform API auto-allow, port scoping, registry gate, and destination binding                           |
| `test_request_handler_tls_admission.py`                 | Request-hook connection-scoped TLS admission revalidation and cleanup                                                |
| `test_request_handler_registry_admission.py`            | Request-hook proxy-registry availability and sandbox entry admission                                                 |
| `test_request_handler_firewall_dispatch.py`             | Core firewall dispatch, permission blocks, malformed config/policy handling, block responses, and unsafe-path blocks |
| `test_request_handler_firewall_auth.py`                 | Request-hook firewall auth identity, credential guards, upstream-binding lifetime, and cancellation                  |
| `test_request_handler_firewall_auth_revalidation.py`    | Registry authorization revalidation across request and requestheaders firewall-auth waits                            |
| `test_request_handler_public_destination.py`            | Request-hook public destination validation and revalidation                                                          |
| `test_request_handler_connector_diagnostics.py`         | Request-hook connector diagnostics and inactive built-in connector diagnostics                                       |
| `test_request_handler_auth_base_body.py`                | Request-hook auth-base body admission and cleanup                                                                    |
| `test_request_headers_streaming.py`                     | Requestheaders stream installation, body framing, buffering, and probe cleanup                                       |
| `test_request_headers_api_admission.py`                 | Requestheaders platform API destination admission and binding                                                        |
| `test_request_headers_connector_admission.py`           | Requestheaders connector destination admission, TLS evidence, and binding                                            |
| `test_request_headers_firewall_auth.py`                 | Requestheaders stream-safe firewall auth, connector intent, fallback, and cancellation cleanup                       |
| `mitmproxy_http_framing_helpers.py`                     | Shared HTTP layer and HTTP/2 request drivers for real mitmproxy framing suites                                       |
| `test_mitmproxy_authority_framing.py`                   | HTTP/1 request-target and HTTP/2 authority validation through the real mitmproxy state machine                       |
| `test_mitmproxy_bodyless_response_framing.py`           | Bodyless local firewall and connector-diagnostic responses through the real mitmproxy state machine                  |
| `test_mitmproxy_codex_catalog_framing.py`               | Codex model-catalog cache and response framing through the real mitmproxy state machine                              |
| `test_mitmproxy_request_body_admission_framing.py`      | auth.base and AWS SigV4 request-body admission through the real mitmproxy state machine                              |
| `test_mitmproxy_websocket_framing.py`                   | Decoded WebSocket message bounds through mitmproxy's state machine and real addon hook dispatch                      |
| `test_request_handler_usage_tracking.py`                | Request-hook billable usage tracking lifecycle                                                                       |
| `test_response_headers_handler.py`                      | Response-header hook stream setup                                                                                    |
| `test_response_handler_connector_diagnostics.py`        | Response-hook connector diagnostic replacement and streaming lifecycle                                               |
| `test_response_handler_logging.py`                      | Response-hook network/proxy logging, size accounting, and body capture                                               |
| `test_response_handler_auth_recovery.py`                | Response-hook 401 firewall-auth cache invalidation and refresh recovery                                              |
| `test_response_handler_cleanup.py`                      | Response-hook terminal request/response stream-state cleanup                                                         |
| `test_error_handler.py`                                 | Error hook logging and usage cleanup                                                                                 |
| `test_done_hook.py`                                     | Shutdown hook delivery, runner flush coordination, and executor cleanup                                              |
| `test_runner_flush_request.py`                          | Runner-triggered usage flush marker contracts                                                                        |
| `test_runner_log_flush.py`                              | Runner-triggered `logs.flush` control requests, bounded prefixes, cancellation, and target validation                |
| `test_runner_usage_flush_signal.py`                     | Runner-triggered usage signal, worker, retry, and timer coordination                                                 |
| `test_tls_clienthello_hook.py`                          | TLS clienthello admission behavior                                                                                   |
| `test_tcp_hooks.py`                                     | TCP start, logging, message drain, end, and error hooks                                                              |
| `test_state_file.py`                                    | Shared safe-open, descriptor identity, bounded-read, and cleanup contracts                                           |
| `test_registry_loading.py`                              | Registry loading, parsing, unavailable-state, and cache behavior                                                     |
| `test_registry_auth_cache_eviction.py`                  | Registry-driven auth-cache ownership and eviction behavior                                                           |
| `test_registry_context.py`                              | Sandbox lookup and public compiled context API behavior                                                              |
| `test_registry_builtin_catalog_resolution.py`           | Built-in catalog resolution and resolver contracts                                                                   |
| `test_registry_builtin_snapshot.py`                     | Built-in catalog snapshot identity and invalidation                                                                  |
| `test_registry_builtin_catalog_validation.py`           | Built-in catalog payload and file-trust validation                                                                   |
| `test_registry_builtin_core_cache.py`                   | Compiled built-in core reuse, scoping, pruning, and lifecycle                                                        |
| `test_registry_inline_firewalls.py`                     | Inline registry firewall behavior outside the built-in catalog cache                                                 |
| `test_registry_builtin_base_url_vars.py`                | Registry built-in base URL variable resolution and validation                                                        |
| `test_registry_context_state.py`                        | Registry compiled context reload, unavailable-state, and malformed-shape behavior                                    |
| `test_matching_path.py`                                 | Low-level firewall path matching                                                                                     |
| `test_matching_host.py`                                 | Low-level firewall host matching                                                                                     |
| `test_matching_path_prefix.py`                          | Low-level firewall path-prefix matching                                                                              |
| `test_matching_base_url_static.py`                      | Static firewall base URL matching and authority normalization                                                        |
| `test_matching_base_url_parameterized.py`               | Parameterized firewall base URL matching                                                                             |
| `test_matching_anthropic_firewall_scope.py`             | Anthropic firewall scope matching regressions                                                                        |
| `test_firewall_request_matching.py`                     | Raw firewall request matching through the compiled matcher                                                           |
| `test_firewall_request_base_matching.py`                | Request-layer firewall base URL matching through raw firewall config                                                 |
| `test_firewall_request_rel_path.py`                     | Request-layer `rel_path` propagation through raw firewall config                                                     |
| `test_firewall_network_policy_decisions.py`             | Request-layer network policy decision behavior                                                                       |
| `test_compiled_firewall_base_path_matching.py`          | Compiled firewall base path, rule path, segment boundary, and path syntax matching                                   |
| `test_compiled_firewall_host_base_matching.py`          | Compiled firewall host-parameterized base matching                                                                   |
| `test_compiled_firewall_authority_normalization.py`     | Compiled firewall runtime URL, authority, and port normalization                                                     |
| `test_compiled_firewall_idna_matching.py`               | Compiled firewall IDNA authority matching and compatibility-alias rejection                                          |
| `test_compiled_firewall_unknown_policy.py`              | Compiled firewall unknown-policy and unsafe-path behavior                                                            |
| `test_compiled_firewall_base_specificity_precedence.py` | Compiled firewall base specificity precedence                                                                        |
| `test_compiled_firewall_cross_firewall_precedence.py`   | Compiled firewall cross-firewall and permission ordering precedence                                                  |
| `test_compiled_firewall_malformed_auth.py`              | Compiled firewall malformed auth config behavior                                                                     |
| `test_compiled_firewall_malformed_base.py`              | Compiled firewall malformed base and base-scope behavior                                                             |
| `test_compiled_firewall_malformed_permissions.py`       | Compiled firewall malformed permission behavior                                                                      |
| `test_compiled_firewall_malformed_policies.py`          | Compiled firewall malformed policy and payload-shape behavior                                                        |
| `test_compiled_firewall_malformed_precedence.py`        | Compiled firewall malformed config and malformed network-policy precedence                                           |
| `test_compiled_firewall_malformed_rules.py`             | Compiled firewall malformed rule and rule-shape behavior                                                             |
| `test_compiled_firewall_permission_aggregation.py`      | Compiled firewall denied-permission aggregation and deduplication                                                    |
| `test_compiled_firewall_rule_specificity_precedence.py` | Compiled firewall rule ordering and rule specificity precedence                                                      |
| `test_auth_cache.py`                                    | Firewall auth cache expiry, refresh, coalescing, cancellation, identity, and eviction                                |
| `test_firewall_auth_handling.py`                        | Direct firewall auth request mutation, identity, error mapping, metadata, admission, and cancellation                |
| `test_firewall_auth_client.py`                          | Firewall auth webhook serialization, transport, parsing, body limits, structured errors, and resource cleanup        |
| `test_platform_api.py`                                  | Shared platform API request headers, unredirected credentials, and URL validation                                    |
| `test_auth_base_forwarder_security.py`                  | Auth-base destination validation, SSRF rejection, and validated TCP/TLS construction                                 |
| `test_auth_base_forwarder_protocol.py`                  | Auth-base HTTP framing, header filtering, body bounds, and synchronous cleanup                                       |
| `test_auth_base_forwarder_lifecycle.py`                 | Auth-base abort, admission, deadlines, cancellation, concurrency, worker, and shutdown behavior                      |
| `test_firewall_rewrite_success.py`                      | Firewall auth URL rewrite success behavior                                                                           |
| `test_firewall_rewrite_forwarding.py`                   | Firewall auth URL rewrite forwarding behavior                                                                        |
| `test_firewall_rewrite_safety.py`                       | Firewall auth URL rewrite fail-closed and safety behavior                                                            |
| `test_auth_header_injection.py`                         | Firewall auth bulk header injection, filtering, ordering, and mutation bounds                                        |
| `test_auth_query_injection.py`                          | Firewall auth query injection and query rewrite behavior                                                             |
| `test_host_normalization.py`                            | Shared hostname identity, ASCII fast-path, IDNA, and label-boundary contracts                                        |
| `test_url_syntax.py`                                    | Shared raw URL code-point, whitespace, backslash, and safe-input fast-path contracts                                 |
| `test_auth_base_rewrite.py`                             | Rewrite URL, path, query, and auth-base URL validation cases                                                         |
| `test_request_authority.py`                             | Trusted request authority success and URL reconstruction                                                             |
| `test_request_authority_rejection.py`                   | Trusted request authority rejection matrices                                                                         |
| `test_body_capture_decompression.py`                    | Capture-level body decompression integration                                                                         |
| `test_body_capture_encoding.py`                         | Body capture text detection, encoding, and UTF-8 truncation helpers                                                  |
| `test_body_capture_fields.py`                           | Ordinary request/response body capture fields                                                                        |
| `test_body_capture_headers.py`                          | Captured network-log header sanitization                                                                             |
| `test_body_capture_stream_buffer.py`                    | Body capture stream-buffer contracts                                                                                 |
| `test_body_decoding.py`                                 | Shared body decoding, streaming decode, codec limits, and decompression errors                                       |
| `test_zlib_decoding.py`                                 | Bounded complete-stream zlib traversal, member, tail, and output-limit contracts                                     |
| `test_anthropic_messages.py`                            | Anthropic Messages SSE and JSON usage extraction                                                                     |
| `test_openai_responses_event_json.py`                   | OpenAI Responses event JSON usage extraction and merge behavior                                                      |
| `test_openai_responses_json.py`                         | OpenAI Responses non-SSE JSON usage extraction                                                                       |
| `test_openai_responses_sse.py`                          | OpenAI Responses SSE usage extraction                                                                                |
| `test_response_stream_buffering.py`                     | Response-stream callback byte counting and bounded capture-buffer retention                                          |
| `test_response_encoding_inspection_risk.py`             | Response decoder admission and non-streamable encoding risk diagnostics                                              |
| `test_x_response_parsers.py`                            | X connector NDJSON and JSON response parser state and finalization                                                   |
| `test_model_provider_response_parser_setup.py`          | Model-provider JSON and SSE response parser selection, feeding, and finalization                                     |
| `test_response_stream_state_release.py`                 | Direct response-stream state release, idempotency, and callback ownership                                            |
| `test_model_provider_json_streaming.py`                 | Model provider streaming JSON response usage pipeline                                                                |
| `model_provider_sse_usage_helpers.py`                   | Shared model-provider SSE flow, hook-driving, compression, and warning test mechanics                                |
| `test_model_provider_sse_usage_openai_responses.py`     | OpenAI Responses-shaped model-provider SSE usage pipeline                                                            |
| `test_model_provider_sse_usage_anthropic.py`            | Anthropic Messages SSE recovery, usage, accounting, retention, and diagnostics pipeline                              |
| `test_model_provider_websocket_prewarm.py`              | Model provider WebSocket prewarm intent, response correlation, and ignored-source diagnostics                        |
| `test_model_provider_websocket_source_reporting.py`     | Model provider WebSocket source reporting, admission, and frame parsing                                              |
| `test_model_provider_websocket_usage_aggregation.py`    | Model provider WebSocket source reconciliation, aggregation, and billing tier state                                  |
| `test_model_provider_websocket_lifecycle.py`            | Model provider WebSocket HTTP upgrade and terminal usage lifecycle                                                   |
| `test_codex_output_timing.py`                           | Default Codex provider-output timing observations over WebSocket                                                     |
| `test_claude_output_timing.py`                          | Claude Code provider-output lifecycle timing over Anthropic SSE                                                      |
| `test_provider_output_timing.py`                        | Cross-provider output-timing store capacity and lifecycle independence                                               |
| `test_websocket_retention.py`                           | Registered WebSocket message retention and cleanup                                                                   |
| `test_model_provider_websocket_metadata.py`             | Model provider WebSocket usage metadata parsing and valid-frame recovery                                             |
| `test_model_provider_usage.py`                          | Model provider usage reporter                                                                                        |
| `x_connector_usage/`                                    | Direct X connector usage billing, write refinement, unparseable fallback, and skip gates                             |
| `test_connector_usage.py`                               | Connector usage reporter and stream-path detection                                                                   |
| `test_usage_idempotency.py`                             | Usage event idempotency key helpers                                                                                  |
| `test_usage_reporting_idempotency.py`                   | Hook-level usage reporting idempotency                                                                               |
| `test_webhook_delivery_admission.py`                    | Usage webhook delivery admission, capacity, pending counter, and executor fallback behavior                          |
| `test_webhook_http_delivery.py`                         | Usage webhook HTTP delivery, retry, request, and log behavior                                                        |
| `test_counters.py`                                      | Usage pending counters                                                                                               |

## Patterns

### Fixtures (conftest.py)

Shared test data via pytest fixtures:

```python
@pytest.fixture
def registry_file(tmp_path):
    """Create a sample proxy registry JSON file."""
    registry = {
        "sandboxes": {
            "10.200.0.1": {
                "runId": "run-abc-123",
                "billableFirewalls": [],
                "sandboxToken": "tok-xyz",
                "networkLogPath": str(tmp_path / "network.jsonl"),
            },
        },
    }
    path = tmp_path / "proxy-registry.json"
    path.write_text(json.dumps(registry))
    return path
```

### Real HTTP Flows

Use the shared `real_flow` fixture when a test needs an HTTP flow. It builds a
real `mitmproxy.http.HTTPFlow` with real request, response, headers, and
metadata semantics, while still letting the test seed metadata for later hook
phases:

```python
import flow_metadata_keys as metadata_keys
import http_network_log


def test_firewall_response_logs_context(tmp_path, real_flow, mitm_ctx):
    flow = real_flow(with_response=True, host="api.github.com", path="/repos")
    flow.metadata.update(
        {
            metadata_keys.SANDBOX_RUN_ID: "run-abc-123",
            metadata_keys.SANDBOX_NETWORK_LOG_PATH: str(tmp_path / "network.jsonl"),
            metadata_keys.ORIGINAL_URL: "https://api.github.com/repos",
            metadata_keys.FIREWALL_ACTION: "ALLOW",
        }
    )
    http_network_log.set_target(
        flow,
        url="https://api.github.com/repos",
        host="api.github.com",
        port=443,
    )

    with mitm_ctx():
        mitm_addon.response(flow)
```

Tests that enter `response()` or `error()` directly with a nonempty network log
path must seed the typed network-log target established by request
classification. Missing target metadata is an invariant violation.

Do not hand-build `MagicMock` HTTP flows for addon hook tests. Mocks and stubs
are still appropriate at real external boundaries such as `mitmproxy.ctx`,
external HTTP clients, or protocol objects that mitmproxy does not expose
through test constructors.

### Module State Reset

The addon uses module-level caches. Reset between tests:

```python
import pytest
import registry

@pytest.fixture(autouse=True)
def _reset_module_state():
    registry.reset_cache_for_tests()
    yield
```

### Mocking with patch

Patch at real external boundaries. For example, request hook tests can use the
shared `fake_firewall_headers` fixture to stub the auth-service boundary while
still running the real dispatcher and firewall handler:

```python
import flow_metadata_keys as metadata_keys


async def test_firewall_request_injects_auth(
    tmp_path, real_flow, mitm_ctx, fake_firewall_headers
):
    reg_path = _write_github_firewall_registry(tmp_path)
    flow = real_flow(with_response=False, host="api.github.com", path="/repos")

    with (
        mitm_ctx(registry_path=str(reg_path)),
        fake_firewall_headers(headers={"Authorization": "Bearer real-token"}),
    ):
        await mitm_addon.request(flow)

    assert flow.request.headers["Authorization"] == "Bearer real-token"
    assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
```

Avoid patching internal handlers only to prove they were called. Assert the flow
state, response, log entry, or other observable behavior produced by the real
hook path.

### Asserting Flow State

Check flow metadata and response after handler execution:

```python
import flow_metadata_keys as metadata_keys


# Service auth injected
assert flow.request.headers["Authorization"] == "Bearer real-token"
assert flow.metadata[metadata_keys.FIREWALL_ACTION] == "ALLOW"
assert flow.metadata[metadata_keys.FIREWALL_BASE] == "https://api.github.com"
```

### Shared Flow Metadata Keys

Shared `flow.metadata` contract keys used across addon modules live in
`src/flow_metadata_keys.py`. Tests may import those constants when seeding
internal metadata for later hook phases. Keep externally visible log or schema
field assertions as string literals so tests still catch accidental output key
changes.

## What to Test

- **URL matching**: `match_service()` with various URLs, path boundaries
- **Request routing**: correct handler called based on registry state
- **Cache behavior**: token caching, expiry, invalidation on 401
- **Registry loading**: valid JSON, missing file, cache refresh

## What NOT to Test

- Real mitmproxy interception (requires running proxy)
- Real HTTP calls to auth endpoint (mock with `patch`)
- TLS certificate handling (mitmproxy internals)
