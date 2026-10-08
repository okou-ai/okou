import {
  normalizeConstantBindings,
  renderRustConstants,
  type NormalizedConstantBinding,
} from "../generate";
import {
  type RustConstantModuleDoc,
  type RustConstantBinding,
  type RustConstantValue,
  rustConstantBindings,
} from "../constants";
import {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
} from "../../contracts/model-providers";
import {
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_APP,
  CLIENT_TYPE_CLI,
  CLIENT_TYPE_DESKTOP,
  CLIENT_TYPE_GUEST_AGENT,
  CLIENT_TYPE_HEADER,
  CLIENT_TYPE_MITM_ADDON,
  CLIENT_TYPE_RUNNER,
  CLIENT_VERSION_HEADER,
} from "../../contracts/client-headers";
import {
  ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES,
  AGENT_EXECUTION_TIMEOUT_SECONDS,
  BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION,
  BUILTIN_FIREWALL_CATALOG_MAX_BYTES,
  CANONICAL_CLAUDE_CONFIG_DIR,
  CANONICAL_CODEX_HOME_DIR,
  CANONICAL_CODEX_SESSIONS_DIR,
  CANONICAL_GUEST_HOME_DIR,
  CANONICAL_PI_SESSION_DIR,
  CANONICAL_WORKING_DIR,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
  CONNECTOR_RUNTIME_SYNC_TARGETS_MAX,
  CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE,
  PI_MODEL_CONFIG_CURRENT_GENERATION,
  PI_MODEL_CONFIG_DIALECT_TIER_GENERATION,
  PI_MODEL_CONFIG_LEGACY_GENERATION,
  RESUME_SESSION_HISTORY_MAX_BYTES,
  RUNNER_CANCELLATION_RECOVERY_GRACE_MS,
  RUNNER_CLAIM_PI_MODEL_CONFIG_GENERATIONS_MAX,
  RUNNER_HOSTNAME_MAX_LENGTH,
  RUNNER_POLL_EXCLUDED_RUN_IDS_MAX,
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
  SESSION_HISTORY_GZIP_MIN_BYTES,
} from "../../contracts/runners";
import {
  STORAGE_MANIFEST_MAX_FILES,
  STORAGE_MANIFEST_MAX_PATH_BYTES,
} from "../../contracts/storages";

const codexOauthPlaceholders =
  MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"].placeholders!;

const canonicalGuestHomeDirDoc = [
  "Canonical home directory path expected for the sandbox user inside runner guests.",
  "Rust and TypeScript components use this shared contract value when building runner guest paths.",
] as const;

const canonicalClaudeConfigDirDoc = [
  "Canonical directory for Okou-managed Claude Code configuration and session state inside runner guests.",
  "Guest launch, session capture, runner restore, and API-managed mounts use this shared path independently of the user HOME environment.",
] as const;

const canonicalCodexHomeDirDoc = [
  "Canonical directory for Okou-managed Codex state inside runner guests.",
  "Guest auth, runtime configuration, session capture, and runner restore use this shared path independently of the user HOME environment.",
] as const;

const canonicalCodexSessionsDirDoc = [
  "Canonical directory for Codex session histories inside runner guests.",
] as const;

const canonicalWorkingDirDoc = [
  "Canonical working directory path expected inside runner guests.",
  "Rust and TypeScript components use this shared contract value when building runner commands and paths.",
] as const;

const canonicalPiSessionDirDoc = [
  "Official Pi JSONL session directory for the canonical guest workspace.",
  "Guest checkpointing validates Pi session files under this directory and runner restore materializes resume history here.",
] as const;

const storageManifestMaxFilesDoc = [
  "Maximum file entries accepted in a storage manifest.",
  "Guest artifact checkpointing and TypeScript storage webhook validation use this shared limit.",
] as const;
const storageManifestMaxPathBytesDoc = [
  "Maximum cumulative UTF-8 path bytes accepted in a storage manifest.",
  "Guest artifact checkpointing and TypeScript storage webhook validation use this shared limit.",
] as const;

const resumeSessionHistoryMaxBytesDoc = [
  "Maximum resume session history blob size accepted by the API, runner, and guest verifier.",
  "Rust and TypeScript components use this shared contract value when validating resume history refs, downloads, and idle-reuse verification.",
] as const;
const activeInputControlPayloadMaxBytesDoc = [
  "Maximum serialized active-input control payload accepted by runner and guest process control.",
  "The API validates the materialized prompt against this shared limit before committing claimed chat events.",
] as const;
const agentExecutionTimeoutSecondsDoc = [
  "Maximum execution budget for one agent run, in seconds.",
  "The runner enforces this deadline and the API includes it in the agent-facing system prompt.",
] as const;
const builtinFirewallCatalogMaxBytesDoc = [
  "Maximum builtin firewall catalog response and cache size accepted by runners.",
  "This Runner wire and cache boundary is independent of the larger full connector catalog source-ingestion limit.",
] as const;
const builtinFirewallCatalogCacheSchemaVersionDoc = [
  "Schema version written to builtin firewall catalog cache files and accepted by the mitm addon.",
  "This value is generated for both Rust and Python consumers so cache compatibility cannot drift between them.",
] as const;
const runnerCancellationRecoveryGraceMsDoc = [
  "Maximum cooperative user-cancellation recovery window enforced by runners.",
  "The API stale barrier remains longer than this runner-owned deadline so delivery latency cannot release a healthy recovery early.",
] as const;
const cancellationRecoveryStaleAfterMsDoc = [
  "Maximum API admission hold after public user cancellation when recovery completion is lost.",
  "The stale queue sweep reconsiders expired recovery barriers independently of the generic queue-item age.",
] as const;
const connectorRuntimeSyncTargetsMaxDoc = [
  "Maximum connector runtime targets accepted by the sync endpoint.",
  "Rust runners use this shared contract value to split target batches before calling the API.",
] as const;
const connectorRuntimeSyncRunTerminalErrorCodeDoc = [
  "API error code returned when connector runtime synchronization targets a terminal run.",
] as const;
const runnerPollExcludedRunIdsMaxDoc = [
  "Maximum runner-local claim cooldown exclusions accepted by the poll endpoint.",
  "Rust runners use this shared contract value to bound local cooldown state and poll request size.",
] as const;

const runnerHostnameMaxLengthDoc = [
  "Maximum configured runner hostname length accepted by the runner-facing API.",
  "Rust runners use JavaScript UTF-16 string length semantics when enforcing this shared boundary.",
] as const;
const sessionHistoryEncodingGzipDoc = [
  "Wire and blob metadata value for gzip-compressed resume session history.",
  "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
] as const;
const sessionHistoryEncodingIdentityDoc = [
  "Wire and blob metadata value for uncompressed resume session history.",
  "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
] as const;
const sessionHistoryEncodingZstdDoc = [
  "Wire and blob metadata value for zstd-compressed resume session history.",
  "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
] as const;
const sessionHistoryDownloadSourceConfiguredPublicEndpointDoc = [
  "Telemetry value for session history downloads signed with a configured S3 endpoint.",
  "Rust and TypeScript components use this shared contract value when attributing runner download latency.",
] as const;
const sessionHistoryDownloadSourceDefaultR2EndpointDoc = [
  "Telemetry value for session history downloads signed with the default R2 endpoint.",
  "Rust and TypeScript components use this shared contract value when attributing runner download latency.",
] as const;
const sessionHistoryGzipMinBytesDoc = [
  "Minimum raw resume session history size before the guest attempts gzip upload negotiation.",
  "Smaller histories stay identity-encoded to avoid gzip work when it cannot materially reduce transport size.",
] as const;
const clientVersionHeaderDoc = [
  "HTTP header carrying the sending platform client component version.",
] as const;
const clientTypeHeaderDoc = [
  "HTTP header carrying the sending platform client component type.",
] as const;
const clientSessionIdHeaderDoc = [
  "HTTP header carrying the sending platform client session identifier.",
] as const;
const clientRequestIdHeaderDoc = [
  "HTTP header carrying the per-request platform client request identifier.",
] as const;

function rustString(value: string): RustConstantValue {
  return { kind: "string", value };
}

function rustU32(value: number): RustConstantValue {
  return { kind: "u32", value };
}

function rustU64(value: number): RustConstantValue {
  return { kind: "u64", value };
}

function placeholderRustDoc(name: string): readonly string[] {
  return [
    `Fake marker bytes for the \`${name}\` placeholder.`,
    "This value is not a secret and must not be treated as a usable credential.",
  ];
}

const expectedBindings = [
  {
    rustModulePath: ["runners"],
    rustConstName: "OFFICIAL_RUNNER_TOKEN_PREFIX",
    rustDoc: [
      "Official token kind; the API still authenticates the secret and winning claim.",
    ],
    value: { kind: "string", value: "vm0_official_" },
  },
  {
    rustModulePath: ["client", "headers"],
    rustConstName: "CLIENT_VERSION_HEADER",
    value: rustString(CLIENT_VERSION_HEADER),
    rustDoc: clientVersionHeaderDoc,
  },
  {
    rustModulePath: ["client", "headers"],
    rustConstName: "CLIENT_TYPE_HEADER",
    value: rustString(CLIENT_TYPE_HEADER),
    rustDoc: clientTypeHeaderDoc,
  },
  {
    rustModulePath: ["client", "headers"],
    rustConstName: "CLIENT_SESSION_ID_HEADER",
    value: rustString(CLIENT_SESSION_ID_HEADER),
    rustDoc: clientSessionIdHeaderDoc,
  },
  {
    rustModulePath: ["client", "headers"],
    rustConstName: "CLIENT_REQUEST_ID_HEADER",
    value: rustString(CLIENT_REQUEST_ID_HEADER),
    rustDoc: clientRequestIdHeaderDoc,
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_APP",
    value: rustString(CLIENT_TYPE_APP),
    rustDoc: ["Client type value for the platform web app."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_CLI",
    value: rustString(CLIENT_TYPE_CLI),
    rustDoc: ["Client type value for the CLI."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_DESKTOP",
    value: rustString(CLIENT_TYPE_DESKTOP),
    rustDoc: ["Client type value for the desktop client."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_GUEST_AGENT",
    value: rustString(CLIENT_TYPE_GUEST_AGENT),
    rustDoc: ["Client type value for the guest agent."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_MITM_ADDON",
    value: rustString(CLIENT_TYPE_MITM_ADDON),
    rustDoc: ["Client type value for the mitmproxy addon."],
  },
  {
    rustModulePath: ["client", "types"],
    rustConstName: "CLIENT_TYPE_RUNNER",
    value: rustString(CLIENT_TYPE_RUNNER),
    rustDoc: ["Client type value for the runner."],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES",
    value: rustU64(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES),
    rustDoc: activeInputControlPayloadMaxBytesDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "AGENT_EXECUTION_TIMEOUT_SECONDS",
    value: rustU64(AGENT_EXECUTION_TIMEOUT_SECONDS),
    rustDoc: agentExecutionTimeoutSecondsDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION",
    value: rustU32(BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION),
    rustDoc: builtinFirewallCatalogCacheSchemaVersionDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "BUILTIN_FIREWALL_CATALOG_MAX_BYTES",
    value: rustU64(BUILTIN_FIREWALL_CATALOG_MAX_BYTES),
    rustDoc: builtinFirewallCatalogMaxBytesDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "CONNECTOR_RUNTIME_SYNC_TARGETS_MAX",
    value: rustU64(CONNECTOR_RUNTIME_SYNC_TARGETS_MAX),
    rustDoc: connectorRuntimeSyncTargetsMaxDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE",
    value: rustString(CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE),
    rustDoc: connectorRuntimeSyncRunTerminalErrorCodeDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "PI_MODEL_CONFIG_CURRENT_GENERATION",
    value: rustU32(PI_MODEL_CONFIG_CURRENT_GENERATION),
    rustDoc: ["Current dialect-aware Pi model configuration generation."],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "PI_MODEL_CONFIG_DIALECT_TIER_GENERATION",
    value: rustU32(PI_MODEL_CONFIG_DIALECT_TIER_GENERATION),
    rustDoc: ["Additive Pi generation with dialect-constrained request tiers."],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "PI_MODEL_CONFIG_LEGACY_GENERATION",
    value: rustU32(PI_MODEL_CONFIG_LEGACY_GENERATION),
    rustDoc: ["Legacy unversioned Pi model configuration generation."],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RESUME_SESSION_HISTORY_MAX_BYTES",
    value: rustU64(RESUME_SESSION_HISTORY_MAX_BYTES),
    rustDoc: resumeSessionHistoryMaxBytesDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RUNNER_CLAIM_PI_MODEL_CONFIG_GENERATIONS_MAX",
    value: rustU64(RUNNER_CLAIM_PI_MODEL_CONFIG_GENERATIONS_MAX),
    rustDoc: [
      "Maximum Pi model configuration generations advertised by one Runner claim.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RUNNER_CANCELLATION_RECOVERY_GRACE_MS",
    value: rustU64(RUNNER_CANCELLATION_RECOVERY_GRACE_MS),
    rustDoc: runnerCancellationRecoveryGraceMsDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "CANCELLATION_RECOVERY_STALE_AFTER_MS",
    value: rustU64(CANCELLATION_RECOVERY_STALE_AFTER_MS),
    rustDoc: cancellationRecoveryStaleAfterMsDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RUNNER_HOSTNAME_MAX_LENGTH",
    value: rustU64(RUNNER_HOSTNAME_MAX_LENGTH),
    rustDoc: runnerHostnameMaxLengthDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RUNNER_POLL_EXCLUDED_RUN_IDS_MAX",
    value: rustU64(RUNNER_POLL_EXCLUDED_RUN_IDS_MAX),
    rustDoc: runnerPollExcludedRunIdsMaxDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_GZIP",
    value: rustString(SESSION_HISTORY_ENCODING_GZIP),
    rustDoc: sessionHistoryEncodingGzipDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_IDENTITY",
    value: rustString(SESSION_HISTORY_ENCODING_IDENTITY),
    rustDoc: sessionHistoryEncodingIdentityDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_ZSTD",
    value: rustString(SESSION_HISTORY_ENCODING_ZSTD),
    rustDoc: sessionHistoryEncodingZstdDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT",
    value: rustString(
      SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
    ),
    rustDoc: sessionHistoryDownloadSourceConfiguredPublicEndpointDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT",
    value: rustString(SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT),
    rustDoc: sessionHistoryDownloadSourceDefaultR2EndpointDoc,
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_GZIP_MIN_BYTES",
    value: rustU64(SESSION_HISTORY_GZIP_MIN_BYTES),
    rustDoc: sessionHistoryGzipMinBytesDoc,
  },
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_GUEST_HOME_DIR",
    value: rustString(CANONICAL_GUEST_HOME_DIR),
    rustDoc: canonicalGuestHomeDirDoc,
  },
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_CLAUDE_CONFIG_DIR",
    value: rustString(CANONICAL_CLAUDE_CONFIG_DIR),
    rustDoc: canonicalClaudeConfigDirDoc,
  },
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_CODEX_HOME_DIR",
    value: rustString(CANONICAL_CODEX_HOME_DIR),
    rustDoc: canonicalCodexHomeDirDoc,
  },
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_CODEX_SESSIONS_DIR",
    value: rustString(CANONICAL_CODEX_SESSIONS_DIR),
    rustDoc: canonicalCodexSessionsDirDoc,
  },
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_WORKING_DIR",
    value: rustString(CANONICAL_WORKING_DIR),
    rustDoc: canonicalWorkingDirDoc,
  },
  {
    rustModulePath: ["runners", "paths"],
    rustConstName: "CANONICAL_PI_SESSION_DIR",
    value: rustString(CANONICAL_PI_SESSION_DIR),
    rustDoc: canonicalPiSessionDirDoc,
  },
  {
    rustModulePath: ["storages"],
    rustConstName: "STORAGE_MANIFEST_MAX_FILES",
    value: rustU64(STORAGE_MANIFEST_MAX_FILES),
    rustDoc: storageManifestMaxFilesDoc,
  },
  {
    rustModulePath: ["storages"],
    rustConstName: "STORAGE_MANIFEST_MAX_PATH_BYTES",
    value: rustU64(STORAGE_MANIFEST_MAX_PATH_BYTES),
    rustDoc: storageManifestMaxPathBytesDoc,
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_ACCESS_TOKEN",
    value: rustString(codexOauthPlaceholders.CHATGPT_ACCESS_TOKEN),
    rustDoc: placeholderRustDoc("CHATGPT_ACCESS_TOKEN"),
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_ACCOUNT_ID",
    value: rustString(codexOauthPlaceholders.CHATGPT_ACCOUNT_ID),
    rustDoc: placeholderRustDoc("CHATGPT_ACCOUNT_ID"),
  },
  {
    rustModulePath: ["codex_oauth_token", "placeholders"],
    rustConstName: "CHATGPT_REFRESH_TOKEN",
    value: rustString(codexOauthPlaceholders.CHATGPT_REFRESH_TOKEN),
    rustDoc: placeholderRustDoc("CHATGPT_REFRESH_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CLAUDE_CODE_OAUTH_TOKEN",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.CLAUDE_CODE_OAUTH_TOKEN),
    rustDoc: placeholderRustDoc("CLAUDE_CODE_OAUTH_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "OPENAI_API_KEY",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY),
    rustDoc: placeholderRustDoc("OPENAI_API_KEY"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_ACCESS_TOKEN",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCESS_TOKEN),
    rustDoc: placeholderRustDoc("CHATGPT_ACCESS_TOKEN"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_ACCOUNT_ID",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_ACCOUNT_ID),
    rustDoc: placeholderRustDoc("CHATGPT_ACCOUNT_ID"),
  },
  {
    rustModulePath: ["model_provider_env", "placeholders"],
    rustConstName: "CHATGPT_REFRESH_TOKEN",
    value: rustString(MODEL_PROVIDER_ENV_PLACEHOLDERS.CHATGPT_REFRESH_TOKEN),
    rustDoc: placeholderRustDoc("CHATGPT_REFRESH_TOKEN"),
  },
] as const;

const exampleModuleDocs = [
  {
    rustModulePath: ["example"],
    rustDoc: ["Example generated constants."],
  },
] satisfies readonly RustConstantModuleDoc[];

function validBinding(
  overrides: Partial<RustConstantBinding> = {},
): RustConstantBinding {
  return {
    rustModulePath: ["example"],
    rustConstName: "EXAMPLE",
    value: rustString("example-value"),
    rustDoc: ["Example generated constant."],
    ...overrides,
  };
}

function summarizeBinding(binding: NormalizedConstantBinding) {
  return {
    rustModulePath: [...binding.rustModulePath],
    rustConstName: binding.rustConstName,
    value: binding.value,
    rustDoc: binding.rustDoc,
  };
}

function compareRustNames(
  left: (typeof expectedBindings)[number],
  right: (typeof expectedBindings)[number],
): number {
  const leftName = [...left.rustModulePath, left.rustConstName].join("::");
  const rightName = [...right.rustModulePath, right.rustConstName].join("::");
  if (leftName < rightName) {
    return -1;
  }
  if (leftName > rightName) {
    return 1;
  }
  return 0;
}

describe("Rust constant bindings", () => {
  it("contains exactly the supported Rust constant set", () => {
    const actualBindings = normalizeConstantBindings(rustConstantBindings).map(
      (binding) => {
        return summarizeBinding(binding);
      },
    );

    expect(actualBindings).toEqual(
      [...expectedBindings].sort(compareRustNames),
    );
  });

  it("renders deterministic Rust constants for the supported registry", () => {
    expect(BUILTIN_FIREWALL_CATALOG_MAX_BYTES).toBe(16 * 1024 * 1024);

    const firstRender = renderRustConstants(rustConstantBindings);
    const secondRender = renderRustConstants(rustConstantBindings);

    expect(secondRender).toBe(firstRender);
    expect(firstRender).toContain("pub mod codex_oauth_token {");
    expect(firstRender).toContain("pub mod model_provider_env {");
    expect(firstRender).toContain("pub mod client {");
    expect(firstRender).toContain("pub mod runners {");
    expect(firstRender).toContain("pub mod storages {");
    expect(firstRender).toContain("pub mod placeholders {");
    expect(firstRender).toContain("pub mod headers {");
    expect(firstRender).toContain(
      "//! Generated Rust constants for `@okouai/api-contracts`.",
    );
    expect(firstRender).toContain(
      "//! Do not edit by hand; regenerate with `cd turbo && pnpm -F @okouai/api-contracts generate:rust`.",
    );
    expect(firstRender).toContain(
      "/// Fake model-provider environment placeholder marker values.",
    );
    expect(firstRender).toContain(
      "/// Fake marker bytes for the `CHATGPT_ACCOUNT_ID` placeholder.",
    );
    expect(firstRender).toContain(
      "/// This value is not a secret and must not be treated as a usable credential.",
    );
    expect(firstRender).toContain(
      "/// Canonical home directory path expected for the sandbox user inside runner guests.",
    );
    expect(firstRender).toContain(
      `pub const CANONICAL_GUEST_HOME_DIR: &str = "${CANONICAL_GUEST_HOME_DIR}";`,
    );
    expect(firstRender).toContain(
      "/// Canonical directory for Okou-managed Claude Code configuration and session state inside runner guests.",
    );
    expect(firstRender).toContain(
      `pub const CANONICAL_CLAUDE_CONFIG_DIR: &str = "${CANONICAL_CLAUDE_CONFIG_DIR}";`,
    );
    expect(firstRender).toContain(
      "/// Canonical directory for Okou-managed Codex state inside runner guests.",
    );
    expect(firstRender).toContain(
      `pub const CANONICAL_CODEX_HOME_DIR: &str = "${CANONICAL_CODEX_HOME_DIR}";`,
    );
    expect(firstRender).toContain(
      `pub const CANONICAL_CODEX_SESSIONS_DIR: &str = "${CANONICAL_CODEX_SESSIONS_DIR}";`,
    );
    expect(firstRender).toContain(
      "/// Canonical working directory path expected inside runner guests.",
    );
    expect(firstRender).toContain(
      `pub const CANONICAL_WORKING_DIR: &str = "${CANONICAL_WORKING_DIR}";`,
    );
    expect(firstRender).toContain(
      "/// Maximum resume session history blob size accepted by the API, runner, and guest verifier.",
    );
    expect(firstRender).toContain(
      `pub const ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES: u64 = ${ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES};`,
    );
    expect(firstRender).toContain(
      `pub const AGENT_EXECUTION_TIMEOUT_SECONDS: u64 = ${AGENT_EXECUTION_TIMEOUT_SECONDS};`,
    );
    expect(firstRender).toContain(
      `pub const BUILTIN_FIREWALL_CATALOG_MAX_BYTES: u64 = ${BUILTIN_FIREWALL_CATALOG_MAX_BYTES};`,
    );
    expect(firstRender).toContain(
      `pub const BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION: u32 = ${BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION};`,
    );
    expect(firstRender).toContain(
      `pub const RESUME_SESSION_HISTORY_MAX_BYTES: u64 = ${RESUME_SESSION_HISTORY_MAX_BYTES};`,
    );
    expect(firstRender).toContain(
      `pub const RUNNER_CANCELLATION_RECOVERY_GRACE_MS: u64 = ${RUNNER_CANCELLATION_RECOVERY_GRACE_MS};`,
    );
    expect(firstRender).toContain(
      `pub const CANCELLATION_RECOVERY_STALE_AFTER_MS: u64 = ${CANCELLATION_RECOVERY_STALE_AFTER_MS};`,
    );
    expect(firstRender).toContain(
      `pub const RUNNER_HOSTNAME_MAX_LENGTH: u64 = ${RUNNER_HOSTNAME_MAX_LENGTH};`,
    );
    expect(firstRender).toContain(
      `pub const RUNNER_POLL_EXCLUDED_RUN_IDS_MAX: u64 = ${RUNNER_POLL_EXCLUDED_RUN_IDS_MAX};`,
    );
    expect(firstRender).toContain(
      `pub const CONNECTOR_RUNTIME_SYNC_TARGETS_MAX: u64 = ${CONNECTOR_RUNTIME_SYNC_TARGETS_MAX};`,
    );
    expect(firstRender).toContain(
      `pub const CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE: &str = "${CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE}";`,
    );
    expect(firstRender).toContain(
      `pub const SESSION_HISTORY_ENCODING_GZIP: &str = "${SESSION_HISTORY_ENCODING_GZIP}";`,
    );
    expect(firstRender).toContain(
      `pub const SESSION_HISTORY_ENCODING_IDENTITY: &str = "${SESSION_HISTORY_ENCODING_IDENTITY}";`,
    );
    expect(firstRender).toContain(
      `pub const SESSION_HISTORY_ENCODING_ZSTD: &str = "${SESSION_HISTORY_ENCODING_ZSTD}";`,
    );
    expect(firstRender).toContain(
      "pub const SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT: &str =",
    );
    expect(firstRender).toContain(
      `"${SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT}";`,
    );
    expect(firstRender).toContain(
      "pub const SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT: &str =",
    );
    expect(firstRender).toContain(
      `"${SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT}";`,
    );
    expect(firstRender).toContain(
      `pub const SESSION_HISTORY_GZIP_MIN_BYTES: u64 = ${SESSION_HISTORY_GZIP_MIN_BYTES};`,
    );
    expect(firstRender).toContain(
      `pub const STORAGE_MANIFEST_MAX_FILES: u64 = ${STORAGE_MANIFEST_MAX_FILES};`,
    );
    expect(firstRender).toContain(
      `pub const STORAGE_MANIFEST_MAX_PATH_BYTES: u64 = ${STORAGE_MANIFEST_MAX_PATH_BYTES};`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_VERSION_HEADER: &str = "${CLIENT_VERSION_HEADER}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_HEADER: &str = "${CLIENT_TYPE_HEADER}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_SESSION_ID_HEADER: &str = "${CLIENT_SESSION_ID_HEADER}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_REQUEST_ID_HEADER: &str = "${CLIENT_REQUEST_ID_HEADER}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_APP: &str = "${CLIENT_TYPE_APP}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_CLI: &str = "${CLIENT_TYPE_CLI}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_DESKTOP: &str = "${CLIENT_TYPE_DESKTOP}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_GUEST_AGENT: &str = "${CLIENT_TYPE_GUEST_AGENT}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_MITM_ADDON: &str = "${CLIENT_TYPE_MITM_ADDON}";`,
    );
    expect(firstRender).toContain(
      `pub const CLIENT_TYPE_RUNNER: &str = "${CLIENT_TYPE_RUNNER}";`,
    );
    expect(firstRender).toContain(
      `pub const CHATGPT_ACCOUNT_ID: &str = "${codexOauthPlaceholders.CHATGPT_ACCOUNT_ID}";`,
    );
    expect(firstRender).toContain("pub const OPENAI_API_KEY: &str =");
    expect(firstRender).toContain(
      MODEL_PROVIDER_ENV_PLACEHOLDERS.OPENAI_API_KEY,
    );
    expect(firstRender).toContain(
      `pub const CHATGPT_REFRESH_TOKEN: &str = "${codexOauthPlaceholders.CHATGPT_REFRESH_TOKEN}";`,
    );
    expect(firstRender).toContain("shared TypeScript/Rust contract values");
  });

  it("escapes Rust string literals", () => {
    const rendered = renderRustConstants(
      [
        validBinding({
          value: rustString(
            'quote" backslash\\ newline\n carriage\r tab\t control\x01',
          ),
        }),
      ],
      exampleModuleDocs,
      ["Example generated constants root."],
    );

    expect(rendered).toContain(
      'pub const EXAMPLE: &str = "quote\\" backslash\\\\ newline\\n carriage\\r tab\\t control\\u{1}";',
    );
  });

  it("fails clearly when a Rust constant name is invalid", () => {
    expect(() => {
      normalizeConstantBindings([
        validBinding({
          rustConstName: "bad_name",
        }),
      ]);
    }).toThrow("invalid Rust const name");
  });

  it("fails clearly when Rust doc lines are empty", () => {
    expect(() => {
      normalizeConstantBindings([
        validBinding({
          rustDoc: [],
        }),
      ]);
    }).toThrow("missing Rust doc lines");
  });

  it("fails clearly when a u64 constant value is invalid", () => {
    expect(() => {
      normalizeConstantBindings([
        validBinding({
          value: rustU64(-1),
        }),
      ]);
    }).toThrow("invalid u64 constant value");
  });

  it.each([-1, 0x1_0000_0000])(
    "fails clearly when a u32 constant value is invalid",
    (value: number) => {
      expect(() => {
        normalizeConstantBindings([
          validBinding({
            value: rustU32(value),
          }),
        ]);
      }).toThrow("invalid u32 constant value");
    },
  );

  it("fails clearly when Rust module docs are missing", () => {
    expect(() => {
      renderRustConstants(
        [validBinding()],
        [],
        ["Example generated constants root."],
      );
    }).toThrow("missing Rust docs for constant module example");
  });

  it("fails clearly when Rust constant names collide", () => {
    expect(() => {
      normalizeConstantBindings([
        validBinding(),
        validBinding({
          value: rustU64(42),
        }),
      ]);
    }).toThrow("duplicate Rust constant binding");
  });
});
