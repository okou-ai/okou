import { z } from "zod";
import { notifyMailBodySchema } from "@okouai/api-contracts/contracts/notifications";

// Retained only to drain previously committed sample email outbox intents.
// New Debug requests run the Official workflow instead of creating samples.
export const debugMorningBriefEmailTemplateSchema = z
  .object({
    template: z.literal("debug-morning-brief"),
    props: z
      .object({
        subject: notifyMailBodySchema.shape.subject,
        text: notifyMailBodySchema.shape.text,
        runUrl: z.url().max(1024),
        manageUrl: z.url().max(1024),
      })
      .strict(),
  })
  .strict();
