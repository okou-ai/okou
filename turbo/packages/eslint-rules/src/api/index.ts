import { dbTransactionExemptions } from "./rules/db-transaction-exemptions.ts";
import { gatewayTypecheckBoundary } from "./rules/gateway-typecheck-boundary.ts";
import { maxSignalOwnerLines } from "./rules/max-signal-owner-lines.ts";
import { noCatchAbort } from "./rules/no-catch-abort.ts";
import { noCrossTestTimeStaggering } from "./rules/no-cross-test-time-staggering.ts";
import { noDatabaseTrigger } from "./rules/no-database-trigger.ts";
import { noDbTransaction } from "./rules/no-db-transaction.ts";
import { noDirectAgentRunTerminalUpdate } from "./rules/no-direct-agent-run-terminal-update.ts";
import { noFnDollarSuffix } from "./rules/no-fn-dollar-suffix.ts";
import { noGetterSetterParams } from "./rules/no-getter-setter-params.ts";
import { noGlobalSweepTestRoutes } from "./rules/no-global-sweep-test-routes.ts";
import { noLegacySharedStateMarkers } from "./rules/no-legacy-shared-state-markers.ts";
import { noLoggerInfo } from "./rules/no-logger-info.ts";
import { noNewAdvisoryLock } from "./rules/no-new-advisory-lock.ts";
import { noNewPromise } from "./rules/no-new-promise.ts";
import { noPackageVariable } from "./rules/no-package-variable.ts";
import { noProductionStaffEntitlementMutation } from "./rules/no-production-staff-entitlement-mutation.ts";
import { noStoreInParams } from "./rules/no-store-in-params.ts";
import { noSqlRaw } from "./rules/no-sql-raw.ts";
import { noTestCredentialForging } from "./rules/no-test-credential-forging.ts";
import { noTestDatabaseBinding } from "./rules/no-test-database-binding.ts";
import { noTestOnlyRoutes } from "./rules/no-test-only-routes.ts";
import { noTestPrivateAccess } from "./rules/no-test-private-access.ts";
import { noTestViMocks } from "./rules/no-test-vi-mocks.ts";
import { noUnownedUsagePricing } from "./rules/no-unowned-usage-pricing.ts";
import { noUnsafeSqlInterpolation } from "./rules/no-unsafe-sql-interpolation.ts";
import { preferDrizzleApis } from "./rules/prefer-drizzle-apis.ts";
import { requireExecuteRowSchema } from "./rules/require-execute-row-schema.ts";
import { requireSqlResultMapping } from "./rules/require-sql-result-mapping.ts";
import { signalCheckAwait } from "./rules/signal-check-await.ts";
import { testControlAllowlist } from "./rules/test-control-allowlist.ts";
import { sqlSourceParser } from "./sql-analysis/sql-source-parser.ts";
import { transactionSqlParser } from "./sql-analysis/transaction-statements.ts";

export { sqlSourceParser, transactionSqlParser };

export const apiLintPlugin = {
  meta: {
    name: "api",
    version: "1.0.0",
  },
  rules: {
    "db-transaction-exemptions": dbTransactionExemptions,
    "gateway-typecheck-boundary": gatewayTypecheckBoundary,
    "max-signal-owner-lines": maxSignalOwnerLines,
    "no-catch-abort": noCatchAbort,
    "no-cross-test-time-staggering": noCrossTestTimeStaggering,
    "no-database-trigger": noDatabaseTrigger,
    "no-db-transaction": noDbTransaction,
    "no-direct-agent-run-terminal-update": noDirectAgentRunTerminalUpdate,
    "no-fn-dollar-suffix": noFnDollarSuffix,
    "no-getter-setter-params": noGetterSetterParams,
    "no-global-sweep-test-routes": noGlobalSweepTestRoutes,
    "no-legacy-shared-state-markers": noLegacySharedStateMarkers,
    "no-logger-info": noLoggerInfo,
    "no-new-advisory-lock": noNewAdvisoryLock,
    "no-new-promise": noNewPromise,
    "no-package-variable": noPackageVariable,
    "no-production-staff-entitlement-mutation":
      noProductionStaffEntitlementMutation,
    "no-store-in-params": noStoreInParams,
    "no-sql-raw": noSqlRaw,
    "no-test-credential-forging": noTestCredentialForging,
    "no-test-vi-mocks": noTestViMocks,
    "no-test-database-binding": noTestDatabaseBinding,
    "no-test-only-routes": noTestOnlyRoutes,
    "no-test-private-access": noTestPrivateAccess,
    "no-unowned-usage-pricing": noUnownedUsagePricing,
    "no-unsafe-sql-interpolation": noUnsafeSqlInterpolation,
    "prefer-drizzle-apis": preferDrizzleApis,
    "require-execute-row-schema": requireExecuteRowSchema,
    "require-sql-result-mapping": requireSqlResultMapping,
    "signal-check-await": signalCheckAwait,
    "test-control-allowlist": testControlAllowlist,
  },
};
