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
    }),
    responses: {
      200: cronMaterializePiResourceIndexesContract.materialize.responses[200],
      404: z.string(),
    },
    summary: "Run resource indexing only for this test's immutable versions",
  },
});
