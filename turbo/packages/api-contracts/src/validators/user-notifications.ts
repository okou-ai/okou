import {
  array,
  boolean,
  discriminatedUnion,
  enum as enumType,
  iso,
  literal,
  number,
  object,
  string,
  uuid,
  type infer as Infer,
} from "zod";

const MAX_NOTIFICATION_PAGES = 10;
const markdownSchema = string().min(1).max(50_000);
export const userNotificationTypeSchema = enumType(["rich_text", "carousel"]);

/** Reading a notification is a receipt, never an approval or other business action. */
export const userNotificationPayloadSchema = discriminatedUnion("type", [
  object({
    type: literal("rich_text"),
    markdown: markdownSchema,
    // Older readers retain the rich-text message while ignoring task metadata.
    automationDisabled: object({
      automationId: uuid(),
      workflowId: uuid(),
      workspaceId: string().min(1),
      workspaceName: string().min(1).max(200).optional(),
      automationName: string().min(1).max(200),
      disabledAt: iso.datetime(),
      consecutiveFailures: number().int().positive(),
      recoveryScheduled: boolean(),
    }).optional(),
  }),
  object({
    type: literal("carousel"),
    pages: array(object({ markdown: markdownSchema }))
      .min(2)
      .max(MAX_NOTIFICATION_PAGES),
  }),
]);

// Add future approval payloads as separate union members, with their own
// decision endpoints and state. Do not overload rich_text or readAt.
export type UserNotificationPayload = Infer<
  typeof userNotificationPayloadSchema
>;
