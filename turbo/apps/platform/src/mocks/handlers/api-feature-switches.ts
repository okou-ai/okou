/**
 * Feature Switches API Handlers
 *
 * Mock handlers for /api/feature-switches endpoint.
 *
 */

import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { mockApi } from "../msw-contract.ts";

export const apiFeatureSwitchesHandlers = [
  mockApi(featureSwitchesContract.get, ({ respond }) => {
    return respond(200, {
      switches: {},
      effectiveSwitches: {},
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
