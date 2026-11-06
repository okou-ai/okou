import {
  discriminatedUnion,
  literal,
  object,
  string,
  url,
  type infer as Infer,
} from "zod";

/** Reading a notification is a receipt, never an approval or other business action. */
export const userNotificationPayloadSchema = discriminatedUnion("type", [
  object({
    type: literal("rich_text"),
    markdown: string().min(1).max(50_000),
    action: object({
      label: string().trim().min(1).max(80),
      url: url({ protocol: /^https$/u }).max(2048),
    }).optional(),
  }),
]);

// Add future approval payloads as separate union members, with their own
// decision endpoints and state. Do not overload rich_text or readAt.
export type UserNotificationPayload = Infer<
  typeof userNotificationPayloadSchema
>;
