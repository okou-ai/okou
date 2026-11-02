import { discriminatedUnion, literal, object, url, uuid } from "zod";

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
