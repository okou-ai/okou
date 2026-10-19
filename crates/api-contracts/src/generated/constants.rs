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

    /// Aggregate final telemetry budget: in-flight and final HTTP/incident delivery plus local settling.
    pub const AGENT_FINAL_TELEMETRY_FLUSH_TIMEOUT_MS: u64 = 39000;

    /// Ordinary telemetry HTTP budget including downstream ingest and API/transport headroom.
    pub const AGENT_TELEMETRY_HTTP_TIMEOUT_MS: u64 = 15000;

    /// Maximum best-effort attempts for each changed emergency incident set.
    pub const AGENT_TELEMETRY_INCIDENT_ATTEMPTS: u64 = 2;

    /// Per-attempt emergency incident budget backed by local evidence and independent host recovery.
    pub const AGENT_TELEMETRY_INCIDENT_TIMEOUT_MS: u64 = 2000;

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

    /// Maximum Guest stdout/stderr drain time after child exit.
    pub const GUEST_EXEC_OUTPUT_DRAIN_DEADLINE_MS: u64 = 5000;

    /// Maximum wait for a contained Guest cgroup to become empty after kill.
    pub const GUEST_EXEC_PROCESS_CONTAINMENT_KILL_EMPTY_TIMEOUT_MS: u64 = 1000;

    /// Maximum retry window for removing an empty Guest exec cgroup.
    pub const GUEST_EXEC_PROCESS_CONTAINMENT_REMOVE_TIMEOUT_MS: u64 = 250;

    /// Grace after signaling contained Guest descendants with SIGTERM.
    pub const GUEST_EXEC_PROCESS_CONTAINMENT_TERM_GRACE_MS: u64 = 500;

    /// Guest terminal cleanup: TERM grace plus kill, removal, and output drain.
    pub const GUEST_EXEC_TERMINAL_CLEANUP_BUDGET_MS: u64 = 6750;

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

    /// Handoff acceptance grace after both predecessor finalization and successor waiting begin.
    pub const RUNNER_FINALIZING_HANDOFF_ACCEPTANCE_GRACE_MS: u64 = 1500;

    /// Active completed predecessor preference: final telemetry plus guest terminal cleanup and host observation grace.
    pub const RUNNER_FINALIZING_PREDECESSOR_PROTECTION_MS: u64 = 49000;

    /// Maximum configured runner hostname length accepted by the runner-facing API.
    /// Rust runners use JavaScript UTF-16 string length semantics when enforcing this shared boundary.
    pub const RUNNER_HOSTNAME_MAX_LENGTH: u64 = 255;

    /// Terminal observation grace, compile-time checked against Guest cleanup plus executor host slack.
    pub const RUNNER_JOB_TERMINAL_GRACE_MS: u64 = 10000;

    /// Host scheduling, observation, and terminal proof delivery allowance.
    pub const RUNNER_JOB_TERMINAL_HOST_SLACK_MS: u64 = 3250;

    /// Maximum runner-local claim cooldown exclusions accepted by the poll endpoint.
    /// Rust runners use this shared contract value to bound local cooldown state and poll request size.
    pub const RUNNER_POLL_EXCLUDED_RUN_IDS_MAX: u64 = 128;

    /// Wire and blob metadata value for gzip-compressed resume session history.
    /// Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.
    pub const SESSION_HISTORY_ENCODING_GZIP: &str = "gzip";

    /// Wire and blob metadata value for uncompressed resume session history.
    /// Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.
    pub const SESSION_HISTORY_ENCODING_IDENTITY: &str = "identity";

    /// Wire and blob metadata value for zstd-compressed resume session history.
    /// Rust and TypeScript components use this shared contract value when negotiating session history uploads and claim responses.
    pub const SESSION_HISTORY_ENCODING_ZSTD: &str = "zstd";

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

/// Sandbox application schema and finite resource policies.
pub mod sandbox_channel {
    /// Shared finite policy: helloTimeoutMs.
    pub const HELLO_TIMEOUT_MS: u32 = 5000;

    /// Shared finite policy: maxCategories.
    pub const MAX_CATEGORIES: u32 = 32;

    /// Shared finite policy: maxCategoryNameBytes.
    pub const MAX_CATEGORY_NAME_BYTES: u32 = 32;

    /// Shared finite policy: maxCategoryVersion.
    pub const MAX_CATEGORY_VERSION: u32 = 2147483647;

    /// Shared finite policy: maxFrameBytes.
    pub const MAX_FRAME_BYTES: u32 = 65536;

    /// Shared finite policy: maxIncoming.
    pub const MAX_INCOMING: u32 = 8;

    /// Shared finite policy: maxJsonDepth.
    pub const MAX_JSON_DEPTH: u32 = 64;

    /// Shared finite policy: maxPending.
    pub const MAX_PENDING: u32 = 8;

    /// Shared finite policy: maxQueuedBytes.
    pub const MAX_QUEUED_BYTES: u32 = 262144;

    /// Shared finite policy: maxQueuedFrames.
    pub const MAX_QUEUED_FRAMES: u32 = 8;

    /// Shared finite policy: requestTimeoutMs.
    pub const REQUEST_TIMEOUT_MS: u32 = 10000;

    /// Shared finite policy: responseOverheadBytes.
    pub const RESPONSE_OVERHEAD_BYTES: u32 = 142;

    /// Shared finite policy: schemaVersion.
    pub const SCHEMA_VERSION: u32 = 1;

    /// Shared finite policy: writeTimeoutMs.
    pub const WRITE_TIMEOUT_MS: u32 = 15000;

    /// Diagnostic category version and payload budget.
    pub mod diagnostics {
        /// Shared finite policy: maxBytes.
        pub const MAX_BYTES: u32 = 16384;

        /// Shared finite policy: version.
        pub const VERSION: u32 = 1;
    }

    /// Readonly filesystem category version and finite policies.
    pub mod fs {
        /// Shared finite policy: cursorIdleMs.
        pub const CURSOR_IDLE_MS: u32 = 30000;

        /// Shared finite policy: handleIdleMs.
        pub const HANDLE_IDLE_MS: u32 = 30000;

        /// Shared finite policy: maxChunkBytes.
        pub const MAX_CHUNK_BYTES: u32 = 32768;

        /// Shared finite policy: maxCursors.
        pub const MAX_CURSORS: u32 = 8;

        /// Shared finite policy: maxDisplayNameBytes.
        pub const MAX_DISPLAY_NAME_BYTES: u32 = 4096;

        /// Shared finite policy: maxEntries.
        pub const MAX_ENTRIES: u32 = 128;

        /// Shared finite policy: maxEnumerationSteps.
        pub const MAX_ENUMERATION_STEPS: u32 = 512;

        /// Shared finite policy: maxHandles.
        pub const MAX_HANDLES: u32 = 4;

        /// Shared finite policy: maxInFlightReads.
        pub const MAX_IN_FLIGHT_READS: u32 = 4;

        /// Shared finite policy: maxNameBytes.
        pub const MAX_NAME_BYTES: u32 = 255;

        /// Shared finite policy: maxPathBytes.
        pub const MAX_PATH_BYTES: u32 = 4096;

        /// Shared finite policy: maxPathComponents.
        pub const MAX_PATH_COMPONENTS: u32 = 64;

        /// Shared finite policy: maxPrefixBytes.
        pub const MAX_PREFIX_BYTES: u32 = 65536;

        /// Shared finite policy: maxPreviewBytes.
        pub const MAX_PREVIEW_BYTES: u32 = 16777216;

        /// Shared finite policy: maxResponseBytes.
        pub const MAX_RESPONSE_BYTES: u32 = 49152;

        /// Shared finite policy: processingBudgetMs.
        pub const PROCESSING_BUDGET_MS: u32 = 2000;

        /// Shared finite policy: version.
        pub const VERSION: u32 = 3;
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
