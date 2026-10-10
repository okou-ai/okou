//! Generated Rust constants for `@okouai/api-contracts`.
//! Do not edit by hand; regenerate with `cd turbo && pnpm -F @okouai/api-contracts generate:rust`.
//! These constants are shared TypeScript/Rust contract values.
//! Token-shaped placeholder values in this module are fake marker bytes, not secrets.

/// Client request contract constants shared by TypeScript and Rust.
pub mod client {
    /// HTTP header names used to identify platform clients in API request logs.
    pub mod headers {
        /// HTTP header carrying the per-request platform client request identifier.
        pub const CLIENT_REQUEST_ID_HEADER: &str = "X-Client-Request-Id";

        /// HTTP header carrying the sending platform client session identifier.
        pub const CLIENT_SESSION_ID_HEADER: &str = "X-Client-Session-Id";

        /// HTTP header carrying the sending platform client component type.
        pub const CLIENT_TYPE_HEADER: &str = "X-Client-Type";

        /// HTTP header carrying the sending platform client component version.
        pub const CLIENT_VERSION_HEADER: &str = "X-Client-Version";
    }

    /// Client type values used to identify platform API request originators.
    pub mod types {
        /// Client type value for the platform web app.
        pub const CLIENT_TYPE_APP: &str = "App";

        /// Client type value for the CLI.
        pub const CLIENT_TYPE_CLI: &str = "CLI";

        /// Client type value for the desktop client.
        pub const CLIENT_TYPE_DESKTOP: &str = "Desktop";

        /// Client type value for the guest agent.
        pub const CLIENT_TYPE_GUEST_AGENT: &str = "GuestAgent";

        /// Client type value for the mitmproxy addon.
        pub const CLIENT_TYPE_MITM_ADDON: &str = "MitmAddon";

        /// Client type value for the runner.
        pub const CLIENT_TYPE_RUNNER: &str = "Runner";
    }
}

/// Codex OAuth token contract constants shared by TypeScript and Rust.
pub mod codex_oauth_token {
    /// Fake Codex OAuth token placeholder marker values.
    /// These values are not secrets and are not usable credentials.
    pub mod placeholders {
        /// Fake marker bytes for the `CHATGPT_ACCESS_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_ACCESS_TOKEN: &str =
            "chatgpt-token-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal";

        /// Fake marker bytes for the `CHATGPT_ACCOUNT_ID` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_ACCOUNT_ID: &str = "ws_VM0_PLACEHOLDER_DO_NOT_TRUST";

        /// Fake marker bytes for the `CHATGPT_REFRESH_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_REFRESH_TOKEN: &str = "rt_VM0_PLACEHOLDER_DO_NOT_TRUST";
    }
}

/// Model-provider environment contract constants shared by TypeScript and Rust.
pub mod model_provider_env {
    /// Fake model-provider environment placeholder marker values.
    /// These values are not secrets and are not usable credentials.
    pub mod placeholders {
        /// Fake marker bytes for the `CHATGPT_ACCESS_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_ACCESS_TOKEN: &str =
            "chatgpt-token-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal";

        /// Fake marker bytes for the `CHATGPT_ACCOUNT_ID` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_ACCOUNT_ID: &str = "ws_VM0_PLACEHOLDER_DO_NOT_TRUST";

        /// Fake marker bytes for the `CHATGPT_REFRESH_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CHATGPT_REFRESH_TOKEN: &str = "rt_VM0_PLACEHOLDER_DO_NOT_TRUST";

        /// Fake marker bytes for the `CLAUDE_CODE_OAUTH_TOKEN` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const CLAUDE_CODE_OAUTH_TOKEN: &str = "sk-ant-oat01-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCofAA";

        /// Fake marker bytes for the `OPENAI_API_KEY` placeholder.
        /// This value is not a secret and must not be treated as a usable credential.
        pub const OPENAI_API_KEY: &str = "sk-proj-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocaT3BlbkFJCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLoca";
    }
}

/// Runner contract constants shared by TypeScript and Rust.
pub mod runners {
    /// Maximum serialized active-input control payload accepted by runner and guest process control.
    /// The API validates the materialized prompt against this shared limit before committing claimed chat events.
    pub const ACTIVE_INPUT_CONTROL_PAYLOAD_MAX_BYTES: u64 = 1048576;

    /// Maximum execution budget for one agent run, in seconds.
    /// The runner enforces this deadline and the API includes it in the agent-facing system prompt.
    pub const AGENT_EXECUTION_TIMEOUT_SECONDS: u64 = 7200;

    /// Schema version written to builtin firewall catalog cache files and accepted by the mitm addon.
    /// This value is generated for both Rust and Python consumers so cache compatibility cannot drift between them.
    pub const BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION: u32 = 1;

    /// Maximum builtin firewall catalog response and cache size accepted by runners.
    /// This Runner wire and cache boundary is independent of the larger full connector catalog source-ingestion limit.
    pub const BUILTIN_FIREWALL_CATALOG_MAX_BYTES: u64 = 16777216;

    /// Maximum API admission hold after public user cancellation when recovery completion is lost.
    /// The stale queue sweep reconsiders expired recovery barriers independently of the generic queue-item age.
    pub const CANCELLATION_RECOVERY_STALE_AFTER_MS: u64 = 120000;

    /// API error code returned when connector runtime synchronization targets a terminal run.
    pub const CONNECTOR_RUNTIME_SYNC_RUN_TERMINAL_ERROR_CODE: &str = "RUN_TERMINAL";

    /// Maximum connector runtime targets accepted by the sync endpoint.
    /// Rust runners use this shared contract value to split target batches before calling the API.
    pub const CONNECTOR_RUNTIME_SYNC_TARGETS_MAX: u64 = 256;

    /// Official token kind; the API still authenticates the secret and winning claim.
    pub const OFFICIAL_RUNNER_TOKEN_PREFIX: &str = "vm0_official_";

    /// Additive Pi generation for OpenRouter Chat Completions routes.
    pub const PI_MODEL_CONFIG_CHAT_COMPLETIONS_GENERATION: u32 = 5;

    /// Current dialect-aware Pi model configuration generation.
    pub const PI_MODEL_CONFIG_CURRENT_GENERATION: u32 = 2;

    /// Additive Pi generation with dialect-constrained request tiers.
    pub const PI_MODEL_CONFIG_DIALECT_TIER_GENERATION: u32 = 3;

    /// Maximum resume session history blob size accepted by the API, runner, and guest verifier.
    /// Rust and TypeScript components use this shared contract value when validating resume history refs, downloads, and idle-reuse verification.
    pub const RESUME_SESSION_HISTORY_MAX_BYTES: u64 = 134217728;

    /// Maximum cooperative user-cancellation recovery window enforced by runners.
    /// The API stale barrier remains longer than this runner-owned deadline so delivery latency cannot release a healthy recovery early.
    pub const RUNNER_CANCELLATION_RECOVERY_GRACE_MS: u64 = 90000;

    /// Maximum Pi model configuration generations advertised by one Runner claim.
    pub const RUNNER_CLAIM_PI_MODEL_CONFIG_GENERATIONS_MAX: u64 = 8;

    /// Maximum configured runner hostname length accepted by the runner-facing API.
    /// Rust runners use JavaScript UTF-16 string length semantics when enforcing this shared boundary.
    pub const RUNNER_HOSTNAME_MAX_LENGTH: u64 = 255;

    /// Maximum runner-local claim cooldown exclusions accepted by the poll endpoint.
    /// Rust runners use this shared contract value to bound local cooldown state and poll request size.
    pub const RUNNER_POLL_EXCLUDED_RUN_IDS_MAX: u64 = 128;

    /// Telemetry value for session history downloads signed with a configured S3 endpoint.
    /// Rust and TypeScript components use this shared contract value when attributing runner download latency.
    pub const SESSION_HISTORY_DOWNLOAD_SOURCE_CONFIGURED_PUBLIC_ENDPOINT: &str =
        "configured_public_endpoint";

    /// Telemetry value for session history downloads signed with the default R2 endpoint.
    /// Rust and TypeScript components use this shared contract value when attributing runner download latency.
    pub const SESSION_HISTORY_DOWNLOAD_SOURCE_DEFAULT_R2_ENDPOINT: &str = "default_r2_endpoint";

    /// Wire and blob metadata value for gzip-compressed resume session history.
    /// Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.
    pub const SESSION_HISTORY_ENCODING_GZIP: &str = "gzip";

    /// Wire and blob metadata value for uncompressed resume session history.
    /// Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.
    pub const SESSION_HISTORY_ENCODING_IDENTITY: &str = "identity";

    /// Wire and blob metadata value for zstd-compressed resume session history.
    /// Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.
    pub const SESSION_HISTORY_ENCODING_ZSTD: &str = "zstd";

    /// Minimum raw resume session history size before the guest attempts gzip upload negotiation.
    /// Smaller histories stay identity-encoded to avoid gzip work when it cannot materially reduce transport size.
    pub const SESSION_HISTORY_GZIP_MIN_BYTES: u64 = 65536;

    /// Runner and guest filesystem path constants shared across Rust and TypeScript.
    pub mod paths {
        /// Canonical directory for Okou-managed Claude Code configuration and session state inside runner guests.
        /// Guest launch, session capture, runner restore, and API-managed mounts use this shared path independently of the user HOME environment.
        pub const CANONICAL_CLAUDE_CONFIG_DIR: &str = "/home/user/.claude";

        /// Canonical directory for Okou-managed Codex state inside runner guests.
        /// Guest auth, runtime configuration, session capture, and runner restore use this shared path independently of the user HOME environment.
        pub const CANONICAL_CODEX_HOME_DIR: &str = "/home/user/.codex";

        /// Canonical directory for Codex session histories inside runner guests.
        pub const CANONICAL_CODEX_SESSIONS_DIR: &str = "/home/user/.codex/sessions";

        /// Canonical home directory path expected for the sandbox user inside runner guests.
        /// Rust and TypeScript components use this shared contract value when building runner guest paths.
        pub const CANONICAL_GUEST_HOME_DIR: &str = "/home/user";

        /// Official Pi JSONL session directory for the canonical guest workspace.
        /// Guest finalization validates Pi session files under this directory and runner restore materializes resume history here.
        pub const CANONICAL_PI_SESSION_DIR: &str =
            "/home/user/.pi/agent/sessions/--home-user-workspace--";

        /// Canonical working directory path expected inside runner guests.
        /// Rust and TypeScript components use this shared contract value when building runner commands and paths.
        pub const CANONICAL_WORKING_DIR: &str = "/home/user/workspace";
    }
}

/// Storage manifest contract constants shared by TypeScript and Rust.
pub mod storages {
    /// Maximum file entries accepted in a storage manifest.
    /// Guest artifact publication and TypeScript storage webhook validation use this shared limit.
    pub const STORAGE_MANIFEST_MAX_FILES: u64 = 50000;

    /// Maximum cumulative UTF-8 path bytes accepted in a storage manifest.
    /// Guest artifact publication and TypeScript storage webhook validation use this shared limit.
    pub const STORAGE_MANIFEST_MAX_PATH_BYTES: u64 = 8388608;
}
