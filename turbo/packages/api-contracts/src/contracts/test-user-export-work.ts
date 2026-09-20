import { z } from "zod";
import { initContract } from "./base";

const c = initContract();
export const testUserExportWorkContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/user-export-work",
    body: z.object({
      action: z.enum([
        "run",
        "inspect",
        "make-due",
        "expire-lease",
        "cleanup",
        "make-cleanup-due",
        "delete",
      ]),
      jobId: z.string().uuid(),
      userId: z.string().min(1),
      maxSteps: z.number().int().min(1).max(200).optional(),
    }),
    responses: {
      200: z.object({
        ok: z.literal(true),
        processed: z.number().optional(),
        state: z
          .object({
            status: z.string(),
            phase: z.string().nullable(),
            failureCount: z.number(),
          })
          .nullable()
          .optional(),
      }),
      400: z.object({ error: z.string() }),
      404: z.string(),
    },
    summary: "Run or inspect one explicitly owned export job in tests",
  },
});
