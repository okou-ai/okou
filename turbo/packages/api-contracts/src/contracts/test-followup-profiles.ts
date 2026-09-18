import { z } from "zod";
import { initContract } from "./base";

const c = initContract();

/** Scoped worker entry point mounted only by API integration tests. */
export const testFollowupProfilesContract = c.router({
  refresh: {
    method: "POST",
    path: "/api/test/followup-profiles/refresh",
    body: z.object({ userId: z.string().min(1), orgId: z.string().min(1) }),
    responses: {
      200: z.object({ attempted: z.number().int().nonnegative() }),
      404: z.string(),
    },
    summary: "Run followup preference work for one isolated test owner",
  },
});
