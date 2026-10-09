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
const imageResponse = c.otherResponse({
  contentType: "image/png",
  body: c.type<Blob>(),
});
export const artifactOgContract = c.router({
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
      z.object({ version: z.string().max(200) }),
    ),
    responses: { 200: imageResponse, 400: apiErrorSchema, 500: apiErrorSchema },
    summary:
      "Read a version-bound cover only while anonymous publication remains authorized",
  },
  defaultImage: {
    method: "GET",
    path: "/api/artifact-og/default.png",
    responses: { 200: imageResponse },
    summary: "Read the neutral artifact sharing cover",
  },
});
