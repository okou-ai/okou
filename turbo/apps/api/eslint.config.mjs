import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config, oxlint } from "@okouai/eslint-config/base";
import { apiLintPlugin, transactionSqlParser } from "@okouai/eslint-rules/api";
import ccstatePlugin from "@okouai/eslint-rules/ccstate";

const packageRoot = dirname(fileURLToPath(import.meta.url));

// The gateway type-check project (tsconfig.gateways.json) is the single source
// of truth for which modules are allowed to resolve the isolated SDKs, so read
// its file list rather than restating it here. Globs would silently under-
// enforce the boundary, so reject them.
const gatewayModules = JSON.parse(
  fs.readFileSync(resolve(packageRoot, "tsconfig.gateways.json"), "utf8"),
).include.map((entry) => {
  if (entry.includes("*")) {
    throw new Error(
      `tsconfig.gateways.json must list files, not globs: ${entry}`,
    );
  }
  return resolve(packageRoot, entry);
});

// Third-party declaration surfaces that only the gateway project may resolve.
// Add a scope here once its clients move into tsconfig.gateways.json; see
// the ablation numbers in PR #25714.
const isolatedDependencies = [
  "@aws-sdk",
  "@clerk",
  "@slack",
  "@smithy",
  "stripe",
];

const gatewayBoundaryOptions = {
  modules: gatewayModules,
  isolatedDependencies,
};

const restrictedSyntax = [
  {
    selector: "MemberExpression[object.name='process'][property.name='env']",
    message:
      "Use env(name) from lib/env (or signals/external/env) instead of process.env. process.env is only allowed in lib/env.ts.",
  },
  {
    selector:
      "CallExpression[callee.object.name='vi'][callee.property.name='stubEnv']",
    message:
      "Use mockEnv(name, value) from lib/env instead of vi.stubEnv. vi.stubEnv is only allowed in __tests__/env-stub.ts for module-load-time bootstrap.",
  },
  {
    selector:
      "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message:
      "Use now() from lib/time instead of Date.now() so tests can mock time.",
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message:
      "Use nowDate() from lib/time instead of new Date() so tests can mock time.",
  },
  {
    selector: "CallExpression[callee.name='setTimeout']",
    message:
      "Use delay() from the signal-timers package instead of setTimeout, and pass the correct AbortSignal.",
  },
  {
    selector: "CallExpression[callee.name='setInterval']",
    message:
      "Use delay() from the signal-timers package instead of setInterval, and pass the correct AbortSignal.",
  },
  {
    selector: "CallExpression[callee.property.name='setTimeout']",
    message:
      "Use delay() from the signal-timers package instead of setTimeout, and pass the correct AbortSignal.",
  },
  {
    selector: "CallExpression[callee.property.name='setInterval']",
    message:
      "Use delay() from the signal-timers package instead of setInterval, and pass the correct AbortSignal.",
  },
  {
    selector: "TryStatement",
    message:
      "try/catch is not allowed. Centralize guarded operations in signals/utils.ts (e.g. safeJsonParse).",
  },
];

// Promise chaining ban — see issue #13535. .then/.catch hide error and
// loading state; production code should await and centralize guarded async
// work in signals/utils.ts (settle, safeJsonParse, detach, etc.).
const promiseChainSyntax = [
  {
    selector: "CallExpression[callee.property.name='then']",
    message:
      "Promise.then is not allowed. Use await, or centralize the guarded async in signals/utils.ts (settle, detach).",
  },
  {
    selector: "CallExpression[callee.property.name='catch']",
    message:
      "Promise.catch is not allowed. Use settle from signals/utils.ts (or detach for fire-and-forget).",
  },
];

// Narrow exception policy for the promise-chain ban (issue #13535):
// only infrastructure that wraps runtime primitives stays on raw
// .then/.catch. Production code under src/signals/routes and
// src/signals/services must route through the centralized helpers
// (settle, tapError, onRejection, detach, bestEffort).
const promiseChainAllowlist = [
  // pg/OTel instrumentation: needs .then chains around the wrapped pg.query
  // call to attach span lifecycle without forcing an async wrapper around
  // every callback-style overload.
  "src/lib/db-instrumentation.ts",
  // Logger flush: detached `?.catch(() => {})` on Sentry flush in process exit
  // path; cannot use signals/utils helpers because lib/ must not import them.
  "src/lib/log.ts",
  // Centralized async helpers — these implement .then/.catch so the rest of
  // the codebase doesn't have to.
  "src/signals/utils.ts",
  // Runtime wrapper around @vercel/functions waitUntil. It tracks promise
  // settlement for tests while leaving business code on domain helpers.
  "src/signals/context/wait-until.ts",
];

// Test-boundary exception lists name exact files (#37440). A missing path is a
// stale entry, so loading this config fails instead of letting dead
// exemptions accumulate. Globs would silently admit new files; reject them.
function exactTestPaths(label, files) {
  for (const file of files) {
    if (/[*?{}[\]]/.test(file)) {
      throw new Error(`${label} must list exact files, not globs: ${file}`);
    }
    if (!fs.existsSync(resolve(packageRoot, file))) {
      throw new Error(
        `${label} lists a missing file: ${file}. Remove the stale entry; see docs/api/api-testing.md#test-lint-exceptions.`,
      );
    }
  }
  return files;
}

// API tests, suites, cases, fixtures, helpers and executable acceptance
// entrypoints. They construct and observe cases only through production
// interfaces; see docs/api/api-testing.md#no-private-state-access.
const apiTestModuleFiles = [
  "src/**/__tests__/**/*.ts",
  "src/**/__benches__/**/*.ts",
  "src/**/*.bench.ts",
  "src/**/*.test.ts",
  "src/**/*.spec.ts",
  "src/**/*.suite.ts",
  "src/**/*.cases.ts",
  "src/**/test-fixtures/**/*.ts",
  "src/**/helpers/**/*.ts",
  "scripts/**/acceptance.ts",
  "scripts/**/fixture.ts",
];

// Exact infrastructure files that own a specific private dependency. Each
// entry states its responsibility; none may construct or observe business
// state. Never add a scenario fixture here.
const apiTestInfrastructure = [
  {
    file: "src/__tests__/global-setup.ts",
    kinds: ["db-driver"],
    reason:
      "Applies the fixed SQL seed files once per run with one short-lived pg client and checks the UTC session.",
  },
  {
    file: "src/__tests__/pglite-setup.ts",
    kinds: ["db-handle"],
    reason:
      "Binds the centralized DB transport to the current case's database; production SQL is unchanged.",
  },
  {
    file: "src/__tests__/test-context.ts",
    kinds: ["db-handle"],
    reason: "Final case disposal closes the connection pool.",
  },
  {
    file: "src/test-fixtures/pglite-database.ts",
    kinds: ["db-driver"],
    reason:
      "Sole PGlite engine owner (api/no-test-database-binding); builds the isolated case engine.",
  },
  {
    file: "src/test-fixtures/connector-catalog.ts",
    kinds: ["service"],
    reason:
      "Reads the connector catalog source configuration only to restore the external S3 mock.",
  },
  // Self-tests of the API database library itself, kept pending Ethan's
  // decision on moving them to an owning package. They do not exercise
  // business scenarios.
  {
    file: "src/lib/__tests__/db.test.ts",
    kinds: ["db-driver", "db-handle"],
    reason: "Self-test of the DB handle and Drizzle wiring in src/lib/db.ts.",
  },
  {
    file: "src/lib/__tests__/db-instrumentation.test.ts",
    kinds: ["db-driver"],
    reason: "Self-test of the pg query instrumentation in src/lib.",
  },
].map((entry) => {
  exactTestPaths("apiTestInfrastructure", [entry.file]);
  return entry;
});

// Files that already forged credentials when the ratchet was introduced
// (#37440). This list may only shrink: a file leaves it by obtaining
// credentials through the real flow. Never add a file.
const credentialForgingLegacyConsumers = exactTestPaths(
  "credentialForgingLegacyConsumers",
  [
    "src/signals/auth/__tests__/tokens.test.ts",
    "src/signals/routes/__tests__/agent-custom-connectors.test.ts",
    "src/signals/routes/__tests__/agents-by-id.test.ts",
    "src/signals/routes/__tests__/agents-create.test.ts",
    "src/signals/routes/__tests__/agents-update.test.ts",
    "src/signals/routes/__tests__/artifact-catalog.bdd.test.ts",
    "src/signals/routes/__tests__/artifact-downloads.test.ts",
    "src/signals/routes/__tests__/artifact-shares.test.ts",
    "src/signals/routes/__tests__/builtin-mcp-discovery.test.ts",
    "src/signals/routes/__tests__/chat-events-auth.test.ts",
    "src/signals/routes/__tests__/chat-events-identity.test.ts",
    "src/signals/routes/__tests__/chat-thread-indicators.test.ts",
    "src/signals/routes/__tests__/chat-threads-archive.test.ts",
    "src/signals/routes/__tests__/chat-threads-create.test.ts",
    "src/signals/routes/__tests__/chat-threads-get.test.ts",
    "src/signals/routes/__tests__/chat-threads-model-selection.test.ts",
    "src/signals/routes/__tests__/chat-threads-pin-order.test.ts",
    "src/signals/routes/__tests__/chat-threads-rename.test.ts",
    "src/signals/routes/__tests__/chat-threads.bdd.test.ts",
    "src/signals/routes/__tests__/cli-auth.bdd.test.ts",
    "src/signals/routes/__tests__/connector-accounts.test.ts",
    "src/signals/routes/__tests__/connector-catalog.test.ts",
    "src/signals/routes/__tests__/connector-check.test.ts",
    "src/signals/routes/__tests__/connectors-by-slug-get.test.ts",
    "src/signals/routes/__tests__/connectors-scope-diff.test.ts",
    "src/signals/routes/__tests__/connectors-search.test.ts",
    "src/signals/routes/__tests__/email-subscription.test.ts",
    "src/signals/routes/__tests__/finance.test.ts",
    "src/signals/routes/__tests__/helpers/api-bdd-firewall.ts",
    "src/signals/routes/__tests__/helpers/api-bdd-user-config.ts",
    "src/signals/routes/__tests__/helpers/api-bdd-webhooks.ts",
    "src/signals/routes/__tests__/helpers/api-bdd.ts",
    "src/signals/routes/__tests__/helpers/billing-checkout-fixture.ts",
    "src/signals/routes/__tests__/image-io-generate.test.ts",
    "src/signals/routes/__tests__/integrations-feishu-message.test.ts",
    "src/signals/routes/__tests__/integrations-github-files.test.ts",
    "src/signals/routes/__tests__/integrations-slack-message.test.ts",
    "src/signals/routes/__tests__/integrations-slack-read.test.ts",
    "src/signals/routes/__tests__/integrations-slack-upload-init.test.ts",
    "src/signals/routes/__tests__/integrations-slack.test.ts",
    "src/signals/routes/__tests__/integrations-teams.test.ts",
    "src/signals/routes/__tests__/integrations-telegram-message.test.ts",
    "src/signals/routes/__tests__/integrations-telegram-upload-complete.test.ts",
    "src/signals/routes/__tests__/integrations-telegram.test.ts",
    "src/signals/routes/__tests__/lark-integration.test.ts",
    "src/signals/routes/__tests__/mcp-connectors.test.ts",
    "src/signals/routes/__tests__/membership-refresh.test.ts",
    "src/signals/routes/__tests__/model-catalog.test.ts",
    "src/signals/routes/__tests__/paid-tools.test.ts",
    "src/signals/routes/__tests__/run-lifecycle.bdd.cases.ts",
    "src/signals/routes/__tests__/shared-thread-attachments.test.ts",
    "src/signals/routes/__tests__/skill-import.bdd.test.ts",
    "src/signals/routes/__tests__/social-status.test.ts",
    "src/signals/routes/__tests__/ssh-access.test.ts",
    "src/signals/routes/__tests__/subscription-controls.test.ts",
    "src/signals/routes/__tests__/teams-bot.test.ts",
    "src/signals/routes/__tests__/uploads-complete.test.ts",
    "src/signals/routes/__tests__/uploads-prepare.test.ts",
    "src/signals/routes/__tests__/vnc-access.test.ts",
    "src/signals/routes/__tests__/web-download.test.ts",
    "src/signals/routes/__tests__/web-file-url.test.ts",
    "src/signals/routes/__tests__/web-search.test.ts",
    "src/signals/routes/__tests__/webhooks-agent-health-usage-telemetry.test.ts",
    "src/signals/routes/__tests__/webhooks-agent-session-output.test.ts",
    "src/signals/routes/__tests__/webhooks-github-workflow.test.ts",
    "src/signals/routes/__tests__/welcome-chat-threads.test.ts",
  ],
);

// Production `*ForTest(s)` exports that tests may use. Each is a boundary
// control, not a way to construct business state; see
// docs/api/api-testing.md#boundary-test-controls.
const boundaryTestControls = [
  {
    file: "src/lib/log.ts",
    exports: ["__resetForTest"],
    reason: "Resets process logger state between cases; asserts nothing.",
  },
  {
    file: "src/lib/secret-kms-client.ts",
    exports: ["setSecretKmsClientForTests"],
    reason: "Installs the external KMS client mock.",
  },
  {
    file: "src/lib/time.ts",
    exports: ["withMockNowForTest", "withNowScopeForTest"],
    reason: "Scoped application clock control owned by one case.",
  },
  {
    file: "src/signals/context/wait-until.ts",
    exports: ["flushWaitUntilForTest"],
    reason: "Drains tracked waitUntil work before observing effects.",
  },
  {
    file: "src/signals/utils.ts",
    exports: ["acknowledgeDetachedForTest", "collectAllDetachedErrorsForTest"],
    reason: "Detached-error ownership hooks for case teardown.",
  },
  {
    file: "src/signals/auth/tokens.ts",
    exports: [
      "signPatJwtForTests",
      "signSandboxJwtForTests",
      "signSkillImportJwtForTests",
    ],
    reason:
      "Credential signers kept only for credentialForgingLegacyConsumers; no new consumer may import them.",
  },
].map((entry) => {
  exactTestPaths("boundaryTestControls", [entry.file]);
  return entry;
});

const apiTestLoggerImportMessage =
  "API tests must not observe the logger. Assert HTTP responses and effects instead; see docs/api/api-testing.md#no-diagnostics-observation.";

const apiTestDiagnosticsMessage =
  "API tests must not observe the logger or telemetry; assert HTTP responses and effects. See docs/api/api-testing.md#no-diagnostics-observation.";

const apiServiceDirectoryTestMessage =
  "API service-directory tests are prohibited. Exercise behavior through production entry points under routes/__tests__. See docs/api/api-testing.md#file-location.";

const apiTestDiagnosticsSyntax = [
  {
    selector: 'MemberExpression[property.name="axiomLogging"]',
    message: apiTestDiagnosticsMessage,
  },
  {
    selector: 'MemberExpression[property.name="sdkIngest"]',
    message: apiTestDiagnosticsMessage,
  },
  {
    selector: 'MemberExpression[property.name="useRealTelemetry"]',
    message: apiTestDiagnosticsMessage,
  },
];

const lowerLayerRouteImportMessage =
  "Lower layers must not import HTTP route or bootstrap aggregation modules. Move shared behavior to lib, command, computed, external, or service modules.";

const apiTestLoggerImportPatterns = ["**/lib/log", "**/lib/log.js"];

export default [
  {
    ignores: [".typecheck/**"],
  },
  ...config,
  {
    files: [
      "src/signals/services/pick-chat-run.service.ts",
      "src/signals/services/thread-claim-run.service.ts",
    ],
    plugins: { api: apiLintPlugin },
    rules: {
      // These two factories declare one owned graph. Keep the 128-line limit
      // on every operational callback and ordinary function, while checking
      // that the exempted owner itself contains only graph declarations.
      "api/max-signal-owner-lines": [
        "error",
        {
          max: 128,
          owners: ["createPickObjects", "createThreadClaimRunObjects"],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: {
      api: apiLintPlugin,
      ccstate: ccstatePlugin,
    },
    rules: {
      "api/no-catch-abort": "error",
      "api/no-fn-dollar-suffix": "error",
      "api/no-getter-setter-params": "error",
      "api/no-logger-info": "error",
      "api/no-new-promise": "error",
      "api/no-sql-raw": "error",
      "api/no-store-in-params": "error",
      "api/no-unsafe-sql-interpolation": "error",
      "api/prefer-drizzle-apis": "error",
      "api/require-execute-row-schema": "error",
      "api/require-sql-result-mapping": "error",
      "api/signal-check-await": "error",
      "ccstate/no-accessor-escape": "error",
      "ccstate/no-command-in-command": "error",
      "api/no-new-advisory-lock": "error",
    },
  },
  {
    files: ["scripts/**/*.ts"],
    plugins: { api: apiLintPlugin },
    rules: { "api/no-new-advisory-lock": "error" },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    plugins: { api: apiLintPlugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "api/no-db-transaction": "error",
      "api/db-transaction-exemptions": "error",
    },
  },
  {
    files: ["**/*.sql"],
    languageOptions: { parser: transactionSqlParser },
    plugins: { api: apiLintPlugin },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "api/no-db-transaction": "error",
      "api/db-transaction-exemptions": "error",
    },
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    ignores: [
      "**/__tests__/**",
      "**/test-fixtures/**",
      "**/*.test.ts",
      "**/*.spec.ts",
      ...exactTestPaths("no-database-trigger acceptance exemptions", [
        "scripts/chat-event-context/acceptance.ts",
        "scripts/chat-event-auxiliary/acceptance.ts",
      ]),
    ],
    rules: { "api/no-database-trigger": "error" },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      // A request owns one Store, including its background commands.
      "src/signals/context/route.ts",
      "src/**/__tests__/**",
      "src/**/__benches__/**",
      "src/**/test/**",
      "src/**/tests/**",
      "src/**/mocks/**",
      "src/**/test-fixtures/**",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "src/**/*.bench.ts",
      "src/**/test-context.ts",
      "src/scripts/**",
    ],
    rules: {
      "ccstate/no-create-store": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/__tests__/**",
      "src/**/test/**",
      "src/**/tests/**",
      "src/**/test-fixtures/**",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "src/signals/services/agent-run-metadata-write.service.ts",
      "src/signals/services/agent-run-terminal-transition.service.ts",
    ],
    rules: {
      "api/no-direct-agent-run-terminal-update": "error",
    },
  },
  {
    files: ["src/signals/auth/temporary-auth-diagnostics.ts"],
    rules: {
      // #36177 diagnostics stop on 2026-10-29. Axiom drops debug; an expected
      // 401 must not create warning noise. Remove with the temporary emitter.
      "api/no-logger-info": [
        "error",
        { allowedMessages: ["temporary auth failure"] },
      ],
    },
  },
  {
    files: ["src/signals/services/agent-webhook-firewall-auth.service.ts"],
    rules: {
      // One safe receipt after a bounded Gmail retry succeeds. Debug is dropped
      // by Axiom, while a warning would misclassify the recovered attempt.
      "api/no-logger-info": [
        "error",
        { allowedMessages: ["gmail token refresh recovered"] },
      ],
    },
  },
  {
    files: ["src/signals/services/conversation-history-deletion.service.ts"],
    rules: {
      // One content-free aggregate per committed lifecycle deletion, never on
      // rollback/no-op. Debug is dropped by Axiom; this receipt establishes
      // actual forward accounting activity for #33973 production acceptance.
      "api/no-logger-info": [
        "error",
        { allowedMessages: ["Conversation history deletion committed"] },
      ],
    },
  },
  {
    files: ["src/signals/services/codex-reset-credit-expiry.service.ts"],
    rules: {
      // One demand-driven aggregate per minute, not per-read diagnostics.
      // Axiom's default transport drops debug events, so retain this bounded audit.
      "api/no-logger-info": [
        "error",
        { allowedMessages: ["codex reset credit expiry outcomes"] },
      ],
    },
  },
  {
    files: [
      "src/signals/services/model-provider-subscription-usage.service.ts",
    ],
    rules: {
      // A 503 from the ChatGPT usage endpoint is a bounded, already recovered
      // outcome — the list response still carries the stored provider row — so
      // `warn` put every occurrence into the production error review. A
      // sustained rate is still the real signal and the record carries the
      // `status` and provider identity a genuine ChatGPT outage needs, so it
      // has to survive Axiom's info default; debug would drop it entirely.
      // Every other refresh failure, including authentication rejections,
      // stays on the shared warn path.
      "api/no-logger-info": [
        "error",
        { allowedMessages: ["codex usage unavailable upstream"] },
      ],
    },
  },
  {
    files: ["src/signals/services/onboarding.service.ts"],
    rules: {
      "api/no-logger-info": [
        "error",
        {
          allowedMessages: ["Morning Brief onboarding provisioning outcome"],
        },
      ],
    },
  },
  {
    files: ["src/signals/services/morning-brief-enrollment-worker.service.ts"],
    rules: {
      // Only a first attempt, a changed error, or an actual install reaches
      // this record, so it is bounded by enrollment progress rather than by
      // cron ticks. Axiom's default transport drops debug events, and the
      // skipped reasons are the only evidence that enrollment ran and chose
      // not to install.
      "api/no-logger-info": [
        "error",
        { allowedMessages: ["Morning Brief enrollment changed"] },
      ],
    },
  },
  {
    files: ["src/signals/routes/webhooks-clerk.ts"],
    rules: {
      // One record per organization-membership creation. Failures already
      // reach Axiom at warn; the succeeded and skipped outcomes must survive
      // the info default too, or a silent dataset is indistinguishable from a
      // working one.
      "api/no-logger-info": [
        "error",
        { allowedMessages: ["Morning Brief membership provisioning outcome"] },
      ],
    },
  },
  {
    files: ["src/signals/routes/user-preferences.ts"],
    rules: {
      // Both records fire on the timezone initialize call, which an
      // authenticated session invokes once. They share their details object
      // with the warn branch beside them, so retaining them at info adds no
      // field that Axiom does not already receive on failure.
      "api/no-logger-info": [
        "error",
        {
          allowedMessages: [
            "Morning Brief timezone provisioning outcome",
            "Morning Brief initialization outcome",
          ],
        },
      ],
    },
  },
  {
    files: ["src/signals/routes/webhooks-built-in-generations.ts"],
    rules: {
      "api/no-logger-info": [
        "error",
        {
          allowedMessages: [
            "Fal built-in generation webhook reported failed generation",
          ],
        },
      ],
    },
  },
  {
    files: ["src/signals/services/agent-webhook-events.service.ts"],
    rules: {
      "api/no-logger-info": [
        "error",
        {
          allowedMessages: [
            "Required database run output projection backpressured",
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/signals/services/pi-memory-stage1-worker.service.ts",
      "src/signals/services/pi-memory-phase2-worker.service.ts",
    ],
    rules: {
      "api/no-logger-info": [
        "error",
        {
          allowedMessages: [
            "Pi memory Stage 1 candidate processed",
            "Pi memory Phase 2 work completed",
          ],
        },
      ],
    },
  },
  {
    files: ["src/signals/services/pi-memory-stage1-cost.service.ts"],
    rules: {
      // Versioned cost observations are the explicit production budget contract.
      "api/no-logger-info": [
        "error",
        { allowedMessages: ["Pi memory Stage 1 cost observed"] },
      ],
    },
  },
  {
    files: ["src/signals/services/agent-run-failure-log.service.ts"],
    rules: {
      // Guest root filesystem exhaustion is already a classified, bounded
      // execution condition. Preserve the canonical INFO behavior without
      // allowing unrelated completion messages to bypass the noise gate.
      "api/no-logger-info": ["error", { allowedMessages: ["Run failed"] }],
    },
  },
  {
    files: ["src/signals/services/cron-snapshot-chat-events.service.ts"],
    rules: {
      // An expected per-head deadline is bounded backpressure, not a warning,
      // but a genuinely stuck head still needs its stage and duration. Axiom's
      // default transport drops debug events, so retain this record at info.
      "api/no-logger-info": [
        "error",
        {
          allowedMessages: ["Timed out Chat Event Snapshot candidate"],
        },
      ],
    },
  },
  {
    files: ["src/signals/routes/desktop-updates.ts"],
    rules: {
      // An exhausted manifest read is a bounded, recovered outcome that needs
      // no intervention, so `warn` only put every single one into the
      // production error review. A sustained rate is still the real signal and
      // the record carries the `failure_class`, `attempts` and
      // `provider_status` a genuine GitHub outage needs, so it has to survive
      // Axiom's info default; debug would drop it and the request log's `503`
      // is retained for too few days to stand in for it.
      "api/no-logger-info": [
        "error",
        {
          allowedMessages: ["Desktop update manifest upstream unavailable"],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/**/__tests__/**",
      "src/**/test/**",
      "src/**/tests/**",
      "src/**/mocks/**",
      "src/**/test-fixtures/**",
      "src/**/*.test.ts",
      "src/**/*.spec.ts",
      "src/**/test-context.ts",
    ],
    rules: {
      "okou/no-abort-signal-in-object-params": [
        "error",
        {
          allowedFunctions: [
            "createApp",
            "createAppWithRoutes",
            "readTextLines",
            "createDir",
            "remove",
            "createTempFile",
            "exec",
          ],
        },
      ],
    },
  },
  {
    files: ["src/scripts/dev-seed.ts"],
    rules: {
      // PostgreSQL's DO statement requires a code literal, so this local-only
      // seed script uses pg.escapeLiteral before passing the block to sql.raw.
      "api/no-sql-raw": "off",
    },
  },
  {
    files: ["src/signals/utils.ts"],
    rules: {
      "api/no-new-promise": "off",
    },
  },
  {
    files: ["src/lib/db-raw-rows.ts"],
    rules: {
      // This is the single reviewed boundary that turns driver rows into
      // schema-derived values before returning them to application code.
      "api/require-execute-row-schema": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      "api/no-package-variable": "error",
    },
  },
  {
    files: ["src/**/*.ts", "vitest.config.ts"],
    plugins: { api: apiLintPlugin },
    rules: {
      "api/no-test-database-binding": "error",
    },
  },
  // Gateway boundary. Tests are exempt: they type-check in their own smaller
  // program, so an SDK import there does not land in the core program.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/__tests__/**/*.ts", "src/**/*.test.ts"],
    rules: {
      "api/gateway-typecheck-boundary": ["error", gatewayBoundaryOptions],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/lib/env.ts",
      "src/lib/time.ts",
      ...exactTestPaths("restricted-syntax bootstrap exemptions", [
        "src/__tests__/env-stub.ts",
        "src/__tests__/global-setup-env.ts",
      ]),
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restrictedSyntax,
        ...promiseChainSyntax,
      ],
    },
  },
  // Restore the rule without the promise-chain selectors for allowlisted
  // files and test files. Tests intentionally drive promise edge cases;
  // allowlisted production files are tracked legacy surface (see
  // `promiseChainAllowlist` comment). env-stub.ts stays excluded so its
  // bootstrap-only process.env / vi.stubEnv usage is not re-flagged here.
  {
    files: [
      "src/**/__tests__/**/*.ts",
      "src/**/*.test.ts",
      ...promiseChainAllowlist,
    ],
    ignores: exactTestPaths("restricted-syntax bootstrap exemptions", [
      "src/__tests__/env-stub.ts",
      "src/__tests__/global-setup-env.ts",
    ]),
    rules: {
      "no-restricted-syntax": ["error", ...restrictedSyntax],
    },
  },
  {
    files: ["src/**/__tests__/**/*.ts", "src/**/*.test.ts"],
    ignores: exactTestPaths("no-test-vi-mocks exemptions", [
      "src/__tests__/env-stub.ts",
      "src/__tests__/mocks.ts",
    ]),
    rules: {
      "api/no-test-vi-mocks": "error",
    },
  },
  {
    files: [
      "src/**/__tests__/**/*.ts",
      "src/**/*.test.ts",
      "src/test-fixtures/**/*.ts",
    ],
    rules: {
      "ccstate/no-test-delay": "error",
    },
  },
  {
    files: [
      "src/**/__tests__/**/*.ts",
      "src/**/*.test.ts",
      "src/test-fixtures/**/*.ts",
    ],
    rules: {
      "api/no-cross-test-time-staggering": "error",
      "api/no-global-sweep-test-routes": "error",
      "api/no-legacy-shared-state-markers": "error",
      "api/no-production-staff-entitlement-mutation": "error",
      "api/no-unowned-usage-pricing": "error",
    },
  },
  {
    ignores: ["**/dist/**", ".vercel/**"],
  },
  ...oxlint.buildFromOxlintConfigFile("./.oxlintrc.json"),
  {
    files: [
      "src/lib/**/*.ts",
      "src/signals/commands/**/*.ts",
      "src/signals/computed/**/*.ts",
      "src/signals/external/**/*.ts",
      "src/signals/services/**/*.ts",
    ],
    ignores: [
      "src/**/__tests__/**/*.ts",
      "src/**/__benches__/**/*.ts",
      "src/**/*.bench.ts",
      "src/**/*.spec.ts",
      "src/**/*.suite.ts",
      "src/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/routes/*",
                "**/routes/**/*",
                "**/signals/route",
                "**/signals/route.ts",
                "**/signals/e2e-routes",
                "**/signals/e2e-routes.ts",
                "**/production-bootstrap",
                "**/production-bootstrap.ts",
              ],
              message: lowerLayerRouteImportMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/**/__tests__/**/*.ts", "src/**/*.test.ts"],
    ignores: exactTestPaths("logger import exemptions", [
      // The logger is the subject here, not a diagnostic: this suite covers the
      // app factory's log wiring and flush ownership, which no route exposes.
      "src/__tests__/app-factory.test.ts",
    ]),
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: apiTestLoggerImportPatterns,
              message: apiTestLoggerImportMessage,
            },
          ],
        },
      ],
    },
  },
  {
    files: apiTestModuleFiles,
    plugins: { api: apiLintPlugin },
    rules: {
      "api/no-test-private-access": [
        "error",
        { infrastructure: apiTestInfrastructure },
      ],
      "api/no-test-credential-forging": [
        "error",
        { legacyConsumers: credentialForgingLegacyConsumers },
      ],
    },
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    plugins: { api: apiLintPlugin },
    rules: {
      "api/no-test-only-routes": "error",
      "api/test-control-allowlist": [
        "error",
        { controls: boundaryTestControls },
      ],
    },
  },
  // Diagnostics gate: API tests must not reach the logger or telemetry stubs
  // through `context.mocks`. This is the last `no-restricted-syntax` config for
  // the files it matches, so it carries `restrictedSyntax` forward; files in
  // `ignores` fall back to the shared test block above.
  {
    files: ["src/**/__tests__/**/*.ts", "src/**/*.test.ts"],
    ignores: exactTestPaths("diagnostics exemptions", [
      // Bootstrap-only module: it owns the process.env and vi.stubEnv usage
      // that `restrictedSyntax` bans everywhere else.
      "src/__tests__/env-stub.ts",
      "src/__tests__/global-setup-env.ts",
      // The stub definition site installs the logger and telemetry mocks that
      // this rule stops tests from reading; it asserts nothing itself.
      "src/__tests__/mocks.ts",
      // The logger is the subject of this suite, not a diagnostic.
      "src/lib/__tests__/log.test.ts",
      // The Axiom log transport is the subject of this suite.
      "src/lib/__tests__/log-axiom-transport.test.ts",
      // The telemetry SDK client is the subject of this suite.
      "src/signals/external/__tests__/axiom.test.ts",
      // The app factory's log wiring and flush ownership is the subject here,
      // and no route exposes it.
      "src/__tests__/app-factory.test.ts",
    ]),
    rules: {
      "no-restricted-syntax": [
        "error",
        ...restrictedSyntax,
        ...apiTestDiagnosticsSyntax,
      ],
    },
  },
  // Last `no-restricted-syntax` config for these files, so no later test
  // override can replace it. The ban has no file exceptions.
  {
    files: [
      "src/signals/services/**/__tests__/**/*.ts",
      "src/signals/services/**/*.test.ts",
      "src/signals/services/**/*.spec.ts",
      "src/signals/services/**/*.suite.ts",
      "src/signals/services/**/*.cases.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        { selector: "Program", message: apiServiceDirectoryTestMessage },
      ],
    },
  },
];
