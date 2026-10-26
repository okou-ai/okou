import { literal, object, url } from "zod";
import {
  notifyMailSubjectSchema,
  notifyMailTextSchema,
} from "@okouai/api-contracts/contracts/notifications";

// Retained only to drain previously committed sample email outbox intents.
// New Debug requests run the Official workflow instead of creating samples.
export const debugMorningBriefEmailTemplateSchema = object({
  template: literal("debug-morning-brief"),
  props: object({
    subject: notifyMailSubjectSchema,
    text: notifyMailTextSchema,
    runUrl: url().max(1024),
    manageUrl: url().max(1024),
  }).strict(),
}).strict();
