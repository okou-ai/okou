import {
  MODEL_PROVIDER_ENV_PLACEHOLDERS,
  MODEL_PROVIDER_FIREWALL_CONFIGS,
} from "../contracts/model-providers";
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
} from "../contracts/client-headers";
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
  RUNNER_HOSTNAME_MAX_LENGTH,
  OFFICIAL_RUNNER_TOKEN_PREFIX,
  RUNNER_CLAIM_PI_MODEL_CONFIG_GENERATIONS_MAX,
  RUNNER_POLL_EXCLUDED_RUN_IDS_MAX,
  SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
  SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT,
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
  SESSION_HISTORY_GZIP_MIN_BYTES,
} from "../contracts/runners";
import {
  STORAGE_MANIFEST_MAX_FILES,
  STORAGE_MANIFEST_MAX_PATH_BYTES,
} from "../contracts/storages";

export type RustConstantValue =
  | {
      readonly kind: "string";
      readonly value: string;
    }
  | {
      readonly kind: "u32";
      readonly value: number;
    }
  | {
      readonly kind: "u64";
      readonly value: number;
    };

export interface RustConstantBinding {
  readonly rustModulePath: readonly string[];
  readonly rustConstName: string;
  readonly value: RustConstantValue;
  readonly rustDoc: readonly string[];
}

export interface RustConstantModuleDoc {
  readonly rustModulePath: readonly string[];
  readonly rustDoc: readonly string[];
}

const codexOauthPlaceholderNames = [
  "CHATGPT_ACCESS_TOKEN",
  "CHATGPT_ACCOUNT_ID",
  "CHATGPT_REFRESH_TOKEN",
] as const;

type CodexOauthPlaceholderName = (typeof codexOauthPlaceholderNames)[number];

const modelProviderEnvPlaceholderNames = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CHATGPT_ACCESS_TOKEN",
  "CHATGPT_ACCOUNT_ID",
  "CHATGPT_REFRESH_TOKEN",
] as const;

type ModelProviderEnvPlaceholderName =
  (typeof modelProviderEnvPlaceholderNames)[number];

const codexOauthPlaceholderModule = [
  "codex_oauth_token",
  "placeholders",
] as const;

const modelProviderEnvPlaceholderModule = [
  "model_provider_env",
  "placeholders",
] as const;
const clientHeadersModule = ["client", "headers"] as const;
const clientTypesModule = ["client", "types"] as const;
const runnerPathsModule = ["runners", "paths"] as const;
const storagesModule = ["storages"] as const;

export const rustConstantRootDoc = [
  "Generated Rust constants for `@okouai/api-contracts`.",
  "Do not edit by hand; regenerate with `cd turbo && pnpm -F @okouai/api-contracts generate:rust`.",
  "These constants are shared TypeScript/Rust contract values.",
  "Token-shaped placeholder values in this module are fake marker bytes, not secrets.",
] as const;

export const rustConstantModuleDocs = [
  {
    rustModulePath: ["codex_oauth_token"],
    rustDoc: [
      "Codex OAuth token contract constants shared by TypeScript and Rust.",
    ],
  },
  {
    rustModulePath: codexOauthPlaceholderModule,
    rustDoc: [
      "Fake Codex OAuth token placeholder marker values.",
      "These values are not secrets and are not usable credentials.",
    ],
  },
  {
    rustModulePath: ["model_provider_env"],
    rustDoc: [
      "Model-provider environment contract constants shared by TypeScript and Rust.",
    ],
  },
  {
    rustModulePath: modelProviderEnvPlaceholderModule,
    rustDoc: [
      "Fake model-provider environment placeholder marker values.",
      "These values are not secrets and are not usable credentials.",
    ],
  },
  {
    rustModulePath: ["client"],
    rustDoc: [
      "Client request contract constants shared by TypeScript and Rust.",
    ],
  },
  {
    rustModulePath: clientHeadersModule,
    rustDoc: [
      "HTTP header names used to identify platform clients in API request logs.",
    ],
  },
  {
    rustModulePath: clientTypesModule,
    rustDoc: [
      "Client type values used to identify platform API request originators.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustDoc: ["Runner contract constants shared by TypeScript and Rust."],
  },
  {
    rustModulePath: runnerPathsModule,
    rustDoc: [
      "Runner and guest filesystem path constants shared across Rust and TypeScript.",
    ],
  },
  {
    rustModulePath: storagesModule,
    rustDoc: [
      "Storage manifest contract constants shared by TypeScript and Rust.",
    ],
  },
] satisfies readonly RustConstantModuleDoc[];

function codexOauthPlaceholder(name: CodexOauthPlaceholderName): string {
  const value =
    MODEL_PROVIDER_FIREWALL_CONFIGS["codex-oauth-token"].placeholders?.[name];
  if (value === undefined) {
    throw new Error(
      `codex-oauth-token firewall placeholder is missing ${name}`,
    );
  }
  if (value.length === 0) {
    throw new Error(`codex-oauth-token firewall placeholder ${name} is empty`);
  }
  return value;
}

function modelProviderEnvPlaceholder(
  name: ModelProviderEnvPlaceholderName,
): string {
  const value = MODEL_PROVIDER_ENV_PLACEHOLDERS[name];
  if (value.length === 0) {
    throw new Error(`model provider env placeholder ${name} is empty`);
  }
  return value;
}

function placeholderRustDoc(name: string): readonly string[] {
  return [
    `Fake marker bytes for the \`${name}\` placeholder.`,
    "This value is not a secret and must not be treated as a usable credential.",
  ];
}

function rustString(value: string): RustConstantValue {
  return { kind: "string", value };
}

function rustU32(value: number): RustConstantValue {
  return { kind: "u32", value };
}

function rustU64(value: number): RustConstantValue {
  return { kind: "u64", value };
}

export const rustConstantBindings = [
  {
    rustModulePath: ["runners"],
    rustConstName: "OFFICIAL_RUNNER_TOKEN_PREFIX",
    value: { kind: "string", value: OFFICIAL_RUNNER_TOKEN_PREFIX },
    rustDoc: [
      "Official token kind; the API still authenticates the secret and winning claim.",
    ],
  },
  {
    rustModulePath: clientHeadersModule,
    rustConstName: "CLIENT_VERSION_HEADER",
    value: rustString(CLIENT_VERSION_HEADER),
    rustDoc: [
      "HTTP header carrying the sending platform client component version.",
    ],
  },
  {
    rustModulePath: clientHeadersModule,
    rustConstName: "CLIENT_TYPE_HEADER",
    value: rustString(CLIENT_TYPE_HEADER),
    rustDoc: [
      "HTTP header carrying the sending platform client component type.",
    ],
  },
  {
    rustModulePath: clientHeadersModule,
    rustConstName: "CLIENT_SESSION_ID_HEADER",
    value: rustString(CLIENT_SESSION_ID_HEADER),
    rustDoc: [
      "HTTP header carrying the sending platform client session identifier.",
    ],
  },
  {
    rustModulePath: clientHeadersModule,
    rustConstName: "CLIENT_REQUEST_ID_HEADER",
    value: rustString(CLIENT_REQUEST_ID_HEADER),
    rustDoc: [
      "HTTP header carrying the per-request platform client request identifier.",
    ],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_APP",
    value: rustString(CLIENT_TYPE_APP),
    rustDoc: ["Client type value for the platform web app."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_CLI",
    value: rustString(CLIENT_TYPE_CLI),
    rustDoc: ["Client type value for the CLI."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_DESKTOP",
    value: rustString(CLIENT_TYPE_DESKTOP),
    rustDoc: ["Client type value for the desktop client."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_GUEST_AGENT",
    value: rustString(CLIENT_TYPE_GUEST_AGENT),
    rustDoc: ["Client type value for the guest agent."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_MITM_ADDON",
    value: rustString(CLIENT_TYPE_MITM_ADDON),
    rustDoc: ["Client type value for the mitmproxy addon."],
  },
  {
    rustModulePath: clientTypesModule,
    rustConstName: "CLIENT_TYPE_RUNNER",
    value: rustString(CLIENT_TYPE_RUNNER),
    rustDoc: ["Client type value for the runner."],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES",
    value: rustU64(ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES),
    rustDoc: [
      "Maximum serialized active-input control payload accepted by runner and guest process control.",
      "The API validates the materialized prompt against this shared limit before committing claimed chat events.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "AGENT_EXECUTION_TIMEOUT_SECONDS",
    value: rustU64(AGENT_EXECUTION_TIMEOUT_SECONDS),
    rustDoc: [
      "Maximum execution budget for one agent run, in seconds.",
      "The runner enforces this deadline and the API includes it in the agent-facing system prompt.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION",
    value: rustU32(BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION),
    rustDoc: [
      "Schema version written to builtin firewall catalog cache files and accepted by the mitm addon.",
      "This value is generated for both Rust and Python consumers so cache compatibility cannot drift between them.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "BUILTIN_FIREWALL_CATALOG_MAX_BYTES",
    value: rustU64(BUILTIN_FIREWALL_CATALOG_MAX_BYTES),
    rustDoc: [
      "Maximum builtin firewall catalog response and cache size accepted by runners.",
      "This Runner wire and cache boundary is independent of the larger full connector catalog source-ingestion limit.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "CONNECTOR_RUNTIME_SYNC_TARGETS_MAX",
    value: rustU64(CONNECTOR_RUNTIME_SYNC_TARGETS_MAX),
    rustDoc: [
      "Maximum connector runtime targets accepted by the sync endpoint.",
      "Rust runners use this shared contract value to split target batches before calling the API.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE",
    value: rustString(CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE),
    rustDoc: [
      "API error code returned when connector runtime synchronization targets a terminal run.",
    ],
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
    rustDoc: [
      "Maximum resume session history blob size accepted by the API, runner, and guest verifier.",
      "Rust and TypeScript components use this shared contract value when validating resume history refs, downloads, and idle-reuse verification.",
    ],
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
    rustDoc: [
      "Maximum cooperative user-cancellation recovery window enforced by runners.",
      "The API stale barrier remains longer than this runner-owned deadline so delivery latency cannot release a healthy recovery early.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "CANCELLATION_RECOVERY_STALE_AFTER_MS",
    value: rustU64(CANCELLATION_RECOVERY_STALE_AFTER_MS),
    rustDoc: [
      "Maximum API admission hold after public user cancellation when recovery completion is lost.",
      "The stale queue sweep reconsiders expired recovery barriers independently of the generic queue-item age.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RUNNER_HOSTNAME_MAX_LENGTH",
    value: rustU64(RUNNER_HOSTNAME_MAX_LENGTH),
    rustDoc: [
      "Maximum configured runner hostname length accepted by the runner-facing API.",
      "Rust runners use JavaScript UTF-16 string length semantics when enforcing this shared boundary.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "RUNNER_POLL_EXCLUDED_RUN_IDS_MAX",
    value: rustU64(RUNNER_POLL_EXCLUDED_RUN_IDS_MAX),
    rustDoc: [
      "Maximum runner-local claim cooldown exclusions accepted by the poll endpoint.",
      "Rust runners use this shared contract value to bound local cooldown state and poll request size.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_GZIP",
    value: rustString(SESSION_HISTORY_ENCODING_GZIP),
    rustDoc: [
      "Wire and blob metadata value for gzip-compressed resume session history.",
      "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_IDENTITY",
    value: rustString(SESSION_HISTORY_ENCODING_IDENTITY),
    rustDoc: [
      "Wire and blob metadata value for uncompressed resume session history.",
      "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_ENCODING_ZSTD",
    value: rustString(SESSION_HISTORY_ENCODING_ZSTD),
    rustDoc: [
      "Wire and blob metadata value for zstd-compressed resume session history.",
      "Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT",
    value: rustString(
      SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT,
    ),
    rustDoc: [
      "Telemetry value for session history downloads signed with a configured S3 endpoint.",
      "Rust and TypeScript components use this shared contract value when attributing runner download latency.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT",
    value: rustString(SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT),
    rustDoc: [
      "Telemetry value for session history downloads signed with the default R2 endpoint.",
      "Rust and TypeScript components use this shared contract value when attributing runner download latency.",
    ],
  },
  {
    rustModulePath: ["runners"],
    rustConstName: "SESSION_HISTORY_GZIP_MIN_BYTES",
    value: rustU64(SESSION_HISTORY_GZIP_MIN_BYTES),
    rustDoc: [
      "Minimum raw resume session history size before the guest attempts gzip upload negotiation.",
      "Smaller histories stay identity-encoded to avoid gzip work when it cannot materially reduce transport size.",
    ],
  },
  {
    rustModulePath: runnerPathsModule,
    rustConstName: "CANONICAL_GUEST_HOME_DIR",
    value: rustString(CANONICAL_GUEST_HOME_DIR),
    rustDoc: [
      "Canonical home directory path expected for the sandbox user inside runner guests.",
      "Rust and TypeScript components use this shared contract value when building runner guest paths.",
    ],
  },
  {
    rustModulePath: runnerPathsModule,
    rustConstName: "CANONICAL_CLAUDE_CONFIG_DIR",
    value: rustString(CANONICAL_CLAUDE_CONFIG_DIR),
    rustDoc: [
      "Canonical directory for Okou-managed Claude Code configuration and session state inside runner guests.",
      "Guest launch, session capture, runner restore, and API-managed mounts use this shared path independently of the user HOME environment.",
    ],
  },
  {
    rustModulePath: runnerPathsModule,
    rustConstName: "CANONICAL_CODEX_HOME_DIR",
    value: rustString(CANONICAL_CODEX_HOME_DIR),
    rustDoc: [
      "Canonical directory for Okou-managed Codex state inside runner guests.",
      "Guest auth, runtime configuration, session capture, and runner restore use this shared path independently of the user HOME environment.",
    ],
  },
  {
    rustModulePath: runnerPathsModule,
    rustConstName: "CANONICAL_CODEX_SESSIONS_DIR",
    value: rustString(CANONICAL_CODEX_SESSIONS_DIR),
    rustDoc: [
      "Canonical directory for Codex session histories inside runner guests.",
    ],
  },
  {
    rustModulePath: runnerPathsModule,
    rustConstName: "CANONICAL_WORKING_DIR",
    value: rustString(CANONICAL_WORKING_DIR),
    rustDoc: [
      "Canonical working directory path expected inside runner guests.",
      "Rust and TypeScript components use this shared contract value when building runner commands and paths.",
    ],
  },
  {
    rustModulePath: runnerPathsModule,
    rustConstName: "CANONICAL_PI_SESSION_DIR",
    value: rustString(CANONICAL_PI_SESSION_DIR),
    rustDoc: [
      "Official Pi JSONL session directory for the canonical guest workspace.",
      "Guest checkpointing validates Pi session files under this directory and runner restore materializes resume history here.",
    ],
  },
  {
    rustModulePath: storagesModule,
    rustConstName: "STORAGE_MANIFEST_MAX_FILES",
    value: rustU64(STORAGE_MANIFEST_MAX_FILES),
    rustDoc: [
      "Maximum file entries accepted in a storage manifest.",
      "Guest artifact checkpointing and TypeScript storage webhook validation use this shared limit.",
    ],
  },
  {
    rustModulePath: storagesModule,
    rustConstName: "STORAGE_MANIFEST_MAX_PATH_BYTES",
    value: rustU64(STORAGE_MANIFEST_MAX_PATH_BYTES),
    rustDoc: [
      "Maximum cumulative UTF-8 path bytes accepted in a storage manifest.",
      "Guest artifact checkpointing and TypeScript storage webhook validation use this shared limit.",
    ],
  },
  ...codexOauthPlaceholderNames.map((name) => {
    return {
      rustModulePath: codexOauthPlaceholderModule,
      rustConstName: name,
      value: rustString(codexOauthPlaceholder(name)),
      rustDoc: placeholderRustDoc(name),
    };
  }),
  ...modelProviderEnvPlaceholderNames.map((name) => {
    return {
      rustModulePath: modelProviderEnvPlaceholderModule,
      rustConstName: name,
      value: rustString(modelProviderEnvPlaceholder(name)),
      rustDoc: placeholderRustDoc(name),
    };
  }),
] satisfies readonly RustConstantBinding[];
