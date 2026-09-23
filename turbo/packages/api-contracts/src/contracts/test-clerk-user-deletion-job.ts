import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testClerkUserDeletionJobContract = c.router({
  retry: {
    method: "POST",
    path: "/api/test/clerk-user-deletion-job/retry",
    body: z.object({ userId: z.string() }),
    responses: { 200: z.object({ processed: z.number() }) },
  },
});
