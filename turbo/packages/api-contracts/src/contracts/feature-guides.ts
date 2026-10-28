import { initContract, authHeadersSchema } from "./base";
import { apiErrorSchema } from "./errors";
import {
  array,
  boolean,
  discriminatedUnion,
  iso,
  literal,
  object,
  string,
  url,
  uuid,
  type infer as zInfer,
} from "zod";

const c = initContract();
const editionIdSchema = string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const mediaUrlSchema = url({ protocol: /^https$/u });

export const featureGuideMediaSchema = discriminatedUnion("type", [
  object({
    type: literal("image"),
    url: mediaUrlSchema,
    alt: string().min(1).max(500),
  }).strict(),
  object({
    type: literal("video"),
    url: mediaUrlSchema,
    posterUrl: mediaUrlSchema,
    captionsUrl: mediaUrlSchema,
  }).strict(),
  object({
    type: literal("walkthrough"),
    steps: array(
      object({
        title: string().min(1).max(120),
        description: string().min(1).max(1000),
        imageUrl: mediaUrlSchema.optional(),
      }).strict(),
    )
      .min(1)
      .max(6),
  }).strict(),
]);

export const featureGuideContentSchema = object({
  schemaVersion: literal(1),
  title: string().min(1).max(160),
  description: string().min(1).max(1000),
  items: array(
    object({
      featureId: string().min(1).max(100),
      title: string().min(1).max(120),
      description: string().min(1).max(1000),
      media: featureGuideMediaSchema.optional(),
      prompt: string().min(1).max(4000).optional(),
    }).strict(),
  )
    .min(1)
    .max(5)
    .refine((items) => {
      return (
        new Set(
          items.map((item) => {
            return item.featureId;
          }),
        ).size === items.length
      );
    }, "Feature IDs must be unique within an edition"),
}).strict();

export type FeatureGuideContent = zInfer<typeof featureGuideContentSchema>;
export type FeatureGuideMedia = zInfer<typeof featureGuideMediaSchema>;

export const featureGuideEditionSchema = object({
  id: editionIdSchema,
  revisionId: uuid(),
  content: featureGuideContentSchema,
});
export type FeatureGuideEdition = zInfer<typeof featureGuideEditionSchema>;

export const importFeatureGuideSchema = object({
  editionId: editionIdSchema,
  content: featureGuideContentSchema,
  startsAt: iso.datetime(),
  expiresAt: iso.datetime().nullable(),
})
  .strict()
  .refine((value) => {
    return (
      value.expiresAt === null ||
      Date.parse(value.expiresAt) > Date.parse(value.startsAt)
    );
  }, "Expiry must follow the start time");
export type ImportFeatureGuide = zInfer<typeof importFeatureGuideSchema>;

const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  500: apiErrorSchema,
};
export const featureGuidesContract = c.router({
  current: {
    method: "GET",
    path: "/api/feature-guides/current",
    headers: authHeadersSchema,
    query: object({ preview: literal("1").optional() }).optional(),
    responses: {
      200: object({
        edition: featureGuideEditionSchema.nullable(),
        preview: boolean().optional(),
      }),
      ...errors,
    },
    summary: "Get the current published feature guide unless already seen",
  },
  seen: {
    method: "POST",
    path: "/api/feature-guides/:editionId/seen",
    headers: authHeadersSchema,
    pathParams: object({ editionId: editionIdSchema }),
    body: object({ revisionId: uuid() }).strict(),
    responses: { 200: object({ seen: literal(true) }), ...errors },
    summary: "Persist that the signed-in user has seen an edition",
  },
  import: {
    method: "POST",
    path: "/api/internal/feature-guides",
    headers: authHeadersSchema,
    body: importFeatureGuideSchema,
    responses: {
      200: object({ editionId: editionIdSchema, revisionId: uuid() }),
      ...errors,
    },
    summary: "Import an immutable feature guide draft (staff only)",
  },
  publish: {
    method: "POST",
    path: "/api/internal/feature-guides/:editionId/publish",
    headers: authHeadersSchema,
    pathParams: object({ editionId: editionIdSchema }),
    body: object({ revisionId: uuid().nullable() }).strict(),
    responses: { 200: object({ published: boolean() }), ...errors },
    summary:
      "Publish an exact draft revision or withdraw an edition (staff only)",
  },
});
