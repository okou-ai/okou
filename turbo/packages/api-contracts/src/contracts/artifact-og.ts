import {
  discriminatedUnion,
  intersection,
  literal,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { artifactOgMetadataSchema } from "./artifact-og-metadata";

export const artifactOgTargetSchema = discriminatedUnion("kind", [
  object({ kind: literal("host"), id: uuid() }),
  object({
    kind: literal("reference"),
    id: string().regex(/^(?:[a-f0-9]{32}|[a-z0-9]{10})(?:\.[a-z0-9]{1,12})?$/u),
  }),
  object({
    kind: literal("thread"),
    id: uuid(),
    targetId: uuid(),
    token: string().regex(/^(?:[a-z0-9]{10}|[a-f0-9]{24})$/u),
    publicBrand: zEnum(["vm0", "okou"]),
  }),
]);
export type ArtifactOgTarget = zInfer<typeof artifactOgTargetSchema>;
const c = initContract();
export const artifactOgContract = c.router({
  slackImage: {
    method: "GET",
    path: "/api/artifact-og/slack.png",
    query: object({
      url: url().max(2048),
      signature: string().regex(/^[a-f0-9]{64}$/u),
    }),
    responses: {
      302: c.noBody(),
      400: apiErrorSchema,
      403: c.noBody(),
    },
    summary: "Redirect a signed Slack image capability to its original source",
  },
  metadata: {
    method: "GET",
    path: "/api/artifact-og/metadata",
    query: artifactOgTargetSchema,
    responses: {
      200: artifactOgMetadataSchema,
      400: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Read anonymous artifact sharing metadata under the current publication policy",
  },
  image: {
    method: "GET",
    path: "/api/artifact-og/image",
    query: intersection(
      artifactOgTargetSchema,
      object({
        version: string().max(200),
        variant: literal("slack").optional(),
      }),
    ),
    responses: {
      302: c.noBody(),
      400: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary:
      "Redirect to a version-bound original cover while anonymous publication remains authorized",
  },
  defaultImage: {
    method: "GET",
    path: "/api/artifact-og/default.png",
    responses: { 302: c.noBody() },
    summary: "Redirect to the Okou brand sharing cover",
  },
});
