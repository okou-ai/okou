import { z } from "zod";
import { initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { artifactOgMetadataSchema } from "./artifact-og-metadata";

export const artifactOgTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host"), id: z.uuid() }),
  z.object({
    kind: z.literal("reference"),
    id: z
      .string()
      .regex(/^(?:[a-f0-9]{32}|[a-z0-9]{10})(?:\.[a-z0-9]{1,12})?$/u),
  }),
  z.object({
    kind: z.literal("thread"),
    id: z.uuid(),
    targetId: z.uuid(),
    token: z.string().regex(/^(?:[a-z0-9]{10}|[a-f0-9]{24})$/u),
    publicBrand: z.enum(["vm0", "okou"]),
  }),
]);
export type ArtifactOgTarget = z.infer<typeof artifactOgTargetSchema>;
const c = initContract();
export const artifactOgContract = c.router({
  slackImage: {
    method: "GET",
    path: "/api/artifact-og/slack.png",
    query: z.object({
      url: z.url().max(2048),
      signature: z.string().regex(/^[a-f0-9]{64}$/u),
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
    query: z.intersection(
      artifactOgTargetSchema,
      z.object({
        version: z.string().max(200),
        variant: z.literal("slack").optional(),
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
