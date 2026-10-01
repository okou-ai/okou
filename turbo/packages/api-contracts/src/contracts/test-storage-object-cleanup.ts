import { z } from "zod";

import { initContract } from "./base";

const c = initContract();

export const testStorageObjectCleanupContract = c.router({
  retry: {
    method: "POST",
    path: "/api/test/storage-object-cleanup/retry",
    body: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("user"), userId: z.string().min(1) }),
      z.object({ kind: z.literal("organization"), orgId: z.string().min(1) }),
    ]),
    responses: { 200: z.object({ processed: z.number() }) },
  },
});
