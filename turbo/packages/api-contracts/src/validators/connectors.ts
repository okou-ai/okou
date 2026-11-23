import {
  discriminatedUnion,
  literal,
  object,
  url,
  uuid,
  type infer as zInfer,
} from "zod";

export const builtinConnectorAutomaticResponseSchema = discriminatedUnion(
  "result",
  [
    object({
      result: literal("connected"),
      connectionId: uuid(),
    }),
    object({
      result: literal("authorization"),
      authorizationUrl: url(),
      oauthAttemptId: uuid(),
      connectionId: uuid().optional(),
    }),
  ],
);

export const connectorNativeAppReturnSchema = object({
  platform: literal("ios"),
  attemptId: uuid(),
});

export function connectorNativeAppReturnUrl(
  value: zInfer<typeof connectorNativeAppReturnSchema>,
): string {
  const parsed = connectorNativeAppReturnSchema.parse(value);
  return `ai.okou.ios://connector-authorization/${parsed.attemptId}`;
}
