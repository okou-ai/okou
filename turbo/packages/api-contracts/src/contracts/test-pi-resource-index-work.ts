import { z } from "zod";

import { initContract } from "./base";
import { cronMaterializePiResourceIndexesContract } from "./cron";

const c = initContract();

/** The global cron is driven with test-owned versions in integration tests. */
export const testPiResourceIndexWorkContract = c.router({
  run: {
    method: "POST",
    path: "/api/test/pi-resource-index-work",
    body: z.object({
      versionIds: z.array(z.string().length(64)).min(1).max(32),
      stableContextOwner: z
        .object({
          orgId: z.string().min(1),
          userId: z.string().min(1),
          agentId: z.string().uuid(),
        })
        .optional(),
      removeStableContextResourceIndexes: z
        .object({
          ownedStorageNames: z.array(z.string().min(1)).min(1).max(16),
        })
        .optional(),
    }),
    responses: {
      200: cronMaterializePiResourceIndexesContract.materialize.responses[200],
      404: z.string(),
    },
    summary: "Run resource and stable-context work owned by one test fixture",
  },
});
