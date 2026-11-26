import { isVitestEnvironment } from "@okouai/core/test-environment";

/**
 * Type-safe environment variables for the app.
 *
 * Environment variables are optional until they are actually used.
 * Add validation only when a variable is required by the application.
 */

declare global {
  interface Window {
    __vitest_index__?: boolean;
  }
}

export const IN_VITEST = isVitestEnvironment();
