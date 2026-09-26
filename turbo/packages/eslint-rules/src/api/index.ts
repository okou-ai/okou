import { gatewayTypecheckBoundary } from "./rules/gateway-typecheck-boundary.ts";
import { noCatchAbort } from "./rules/no-catch-abort.ts";
import { noCrossTestTimeStaggering } from "./rules/no-cross-test-time-staggering.ts";
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
import { noTestViMocks } from "./rules/no-test-vi-mocks.ts";
import { noUnownedUsagePricing } from "./rules/no-unowned-usage-pricing.ts";
import { noUnsafeSqlInterpolation } from "./rules/no-unsafe-sql-interpolation.ts";
import { preferDrizzleApis } from "./rules/prefer-drizzle-apis.ts";
import { requireExecuteRowSchema } from "./rules/require-execute-row-schema.ts";
import { requireSqlResultMapping } from "./rules/require-sql-result-mapping.ts";
import { signalCheckAwait } from "./rules/signal-check-await.ts";

export const apiLintPlugin = {
  meta: {
    name: "api",
    version: "1.0.0",
  },
  rules: {
    "gateway-typecheck-boundary": gatewayTypecheckBoundary,
    "no-catch-abort": noCatchAbort,
    "no-cross-test-time-staggering": noCrossTestTimeStaggering,
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
    "no-test-vi-mocks": noTestViMocks,
    "no-unowned-usage-pricing": noUnownedUsagePricing,
    "no-unsafe-sql-interpolation": noUnsafeSqlInterpolation,
    "prefer-drizzle-apis": preferDrizzleApis,
    "require-execute-row-schema": requireExecuteRowSchema,
    "require-sql-result-mapping": requireSqlResultMapping,
    "signal-check-await": signalCheckAwait,
  },
};
