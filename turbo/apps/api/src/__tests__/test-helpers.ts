import type { UsagePricingResolution } from "../signals/context/usage-pricing-resolution";
import type { SystemSkillStorageResolution } from "../signals/context/system-skill-storage-resolution";
import type { RouteEntry } from "../signals/route-entry";
import { setupAppWithRoutes, setupRawAppRequestWithRoutes } from "./test-app";
import type { TestContext } from "./test-context";
import { initializeCaseDatabase } from "../test-fixtures/case-database";

interface SetupRawAppOptions {
  readonly context: TestContext;
  readonly routes: readonly RouteEntry[];
  readonly signal?: AbortSignal;
}

interface SetupAppOptions extends SetupRawAppOptions {
  readonly isolatePg?: boolean;
  readonly baseUrl?: string;
  readonly rethrowErrors?: boolean;
  readonly usagePricingResolution?: UsagePricingResolution;
  readonly systemSkillStorageResolution?: SystemSkillStorageResolution;
}

type AppClientFactory = ReturnType<typeof setupAppWithRoutes>;

export function setupApp(
  options: SetupAppOptions & { readonly isolatePg: true },
): Promise<AppClientFactory>;
export function setupApp(
  options: SetupAppOptions & { readonly isolatePg?: false },
): AppClientFactory;
export function setupApp(
  options: SetupAppOptions,
): AppClientFactory | Promise<AppClientFactory>;
export function setupApp({
  isolatePg = false,
  ...options
}: SetupAppOptions): AppClientFactory | Promise<AppClientFactory> {
  if (isolatePg) {
    return setupIsolatedApp(options);
  }
  return setupAppWithRoutes(options);
}

async function setupIsolatedApp(
  options: SetupAppOptions,
): Promise<AppClientFactory> {
  await initializeCaseDatabase();
  return setupAppWithRoutes(options);
}

/**
 * Use only for request shapes the route's contract makes unrepresentable in
 * TypeScript. Prefer `setupApp` for every case the typed client can express.
 */
export function setupRawAppRequest({
  context,
  routes,
  signal,
}: SetupRawAppOptions) {
  return setupRawAppRequestWithRoutes({ context, routes, signal });
}
