import {
  discriminatedUnion,
  enum as zEnum,
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

export const connectorNativeHttpsReturnHostSchema = zEnum([
  "app.okou.ai",
  "staging-app.omby.ai",
]);

export const connectorNativeAppReturnSchema = object({
  platform: literal("ios"),
  attemptId: uuid(),
  httpsHost: connectorNativeHttpsReturnHostSchema.optional(),
});

export type ConnectorNativeAppReturn = zInfer<
  typeof connectorNativeAppReturnSchema
>;

export function connectorNativeAppReturnUrl(
  value: zInfer<typeof connectorNativeAppReturnSchema>,
): string {
  const parsed = connectorNativeAppReturnSchema.parse(value);
  if (parsed.httpsHost) {
    const url = new URL(
      "/native/connector-authorization",
      `https://${parsed.httpsHost}`,
    );
    url.searchParams.set("attemptId", parsed.attemptId);
    return url.toString();
  }
  return `ai.okou.ios://connector-authorization/${parsed.attemptId}`;
}
