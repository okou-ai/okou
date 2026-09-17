/**
 * Test-side override helper for the /api/feature-switches GET handler.
 *
 * Kept separate from `api-feature-switches.ts` so the default handler module
 * remains stateless and test-specific overrides stay in test code.
 */

import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";

import { mockApi } from "../msw-contract.ts";
import { server } from "../server.ts";

export function setMockFeatureSwitches(
  switches: Partial<Record<string, boolean>>,
): void {
  const sanitized: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(switches)) {
    if (value !== undefined) {
      sanitized[key] = value;
    }
  }
  server.use(
    mockApi(featureSwitchesContract.get, ({ respond }) => {
      return respond(200, {
        switches: sanitized,
        effectiveSwitches: sanitized,
      });
    }),
  );
}
