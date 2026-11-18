/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/feature-switches endpoint.
 *
 * Stateless: defaults model a retained multi-Agent member. Tests override the GET response
 * via `setMockFeatureSwitches` from `./api-feature-switches.helpers.ts` —
 * that file imports `server` (msw/node) and is intentionally separate so
 * default handlers stay free of test override side effects.
 */

import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { mockApi } from "../msw-contract.ts";

export const DEFAULT_SWITCH_OVERRIDES = Object.freeze({
  [FeatureSwitchKey.SingleAgent]: false,
});

export const apiFeatureSwitchesHandlers = [
  mockApi(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: DEFAULT_SWITCH_OVERRIDES,
      effectiveSwitches: DEFAULT_SWITCH_OVERRIDES,
    });
  }),

  mockApi(featureSwitchesContract.update, ({ body, respond }) => {
    return respond(200, {
      switches: body.switches,
      effectiveSwitches: body.switches,
    });
  }),

  mockApi(featureSwitchesContract.delete, ({ respond }) => {
    return respond(200, { deleted: true as const });
  }),
];
