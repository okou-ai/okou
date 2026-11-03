import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { artifactUrlSchema } from "./artifact-references";

export const MARKETING_HANDOFF_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MARKETING_HANDOFF_MAX_FILES = 10;
export const marketingContentHashSchema = string().regex(/^[a-f0-9]{64}$/u);
const marketingHandoffShortHashSchema = string().regex(/^[a-f0-9]{8}$/u);
const marketingHandoffHashSchema = string().regex(
  /^(?:[a-f0-9]{8}|[a-f0-9]{64})$/u,
);
const marketingHandoffCreatedSchema = object({
  hash: marketingContentHashSchema,
  // Older API deployments return only the full content digest.
  shortHash: marketingHandoffShortHashSchema.optional(),
});
export const marketingHandoffFileSchema = object({
  hash: marketingContentHashSchema,
  filename: string()
    .min(1)
    .max(255)
    .refine(
      (filename) => {
        return (
          filename !== "." &&
          filename !== ".." &&
          [...filename].every((character) => {
            return character >= " " && character !== "/" && character !== "\\";
          })
        );
      },
      { message: "Invalid filename" },
    ),
  contentType: string().min(1).max(200),
  size: number().int().min(0).max(MARKETING_HANDOFF_MAX_FILE_BYTES),
}).strict();

export const marketingHandoffOptionsSchema = object({
  template: string().min(1).max(200).optional(),
  model: string().min(1).max(200).optional(),
  connector: string().min(1).max(200).optional(),
  showcase: string().max(2048).optional(),
}).strict();

export const marketingHandoffManifestSchema = object({
  version: literal(1),
  prompt: string().max(20000),
  options: marketingHandoffOptionsSchema,
  files: array(marketingHandoffFileSchema).max(MARKETING_HANDOFF_MAX_FILES),
})
  .strict()
  .refine(
    (value) => {
      return value.prompt.trim().length > 0 || value.files.length > 0;
    },
    {
      message: "A prompt or file is required",
    },
  );

export type MarketingHandoffManifest = zInfer<
  typeof marketingHandoffManifestSchema
>;
export type MarketingHandoffFile = zInfer<typeof marketingHandoffFileSchema>;

/** A versioned wire encoding shared with Marketing; identity excludes grants and clicks. */
export function serializeMarketingHandoff(
  manifest: MarketingHandoffManifest,
): string {
  const { template, model, connector, showcase } = manifest.options;
  return JSON.stringify({
    version: 1,
    prompt: manifest.prompt,
    options: { template, model, connector, showcase },
    files: manifest.files.map(({ hash, filename, contentType, size }) => {
      return {
        hash,
        filename,
        contentType,
        size,
      };
    }),
  });
}

const c = initContract();
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  429: apiErrorSchema,
  500: apiErrorSchema,
  503: apiErrorSchema,
};
const importedFileSchema = object({
  id: string(),
  filename: string(),
  contentType: string(),
  size: number(),
  url: artifactUrlSchema,
});
const uploadBodySchema = object({
  filename: marketingHandoffFileSchema.shape.filename,
  contentType: marketingHandoffFileSchema.shape.contentType,
  data: string().max(Math.ceil(MARKETING_HANDOFF_MAX_FILE_BYTES / 3) * 4),
}).strict();
export const marketingHandoffsContract = c.router({
  config: {
    method: "GET",
    path: "/api/marketing-handoffs/config",
    headers: authHeadersSchema,
    responses: { 200: object({ enabled: boolean() }), ...errors },
  },
  session: {
    method: "POST",
    path: "/api/marketing-handoffs/session",
    headers: authHeadersSchema,
    body: object({}),
    responses: { 200: object({ ready: literal(true) }), ...errors },
  },
  upload: {
    method: "POST",
    path: "/api/marketing-handoffs/files",
    headers: authHeadersSchema,
    body: uploadBodySchema,
    responses: { 200: marketingHandoffFileSchema, ...errors },
  },
  create: {
    method: "POST",
    path: "/api/marketing-handoffs",
    headers: authHeadersSchema,
    body: marketingHandoffManifestSchema,
    responses: {
      200: marketingHandoffCreatedSchema,
      409: apiErrorSchema,
      ...errors,
    },
  },
  resolve: {
    method: "POST",
    path: "/api/marketing-handoffs/:hash/resolve",
    headers: authHeadersSchema,
    pathParams: object({ hash: marketingHandoffHashSchema }),
    body: object({}),
    responses: { 200: marketingHandoffManifestSchema, ...errors },
  },
  import: {
    method: "POST",
    path: "/api/marketing-handoffs/:hash/import",
    headers: authHeadersSchema,
    pathParams: object({ hash: marketingHandoffHashSchema }),
    body: object({ intentId: uuid() }).strict(),
    responses: { 200: object({ files: array(importedFileSchema) }), ...errors },
  },
  publish: {
    method: "POST",
    path: "/api/marketing-handoffs/publish",
    headers: authHeadersSchema,
    body: marketingHandoffManifestSchema,
    responses: {
      200: marketingHandoffCreatedSchema,
      409: apiErrorSchema,
      ...errors,
    },
  },
  publishFile: {
    method: "POST",
    path: "/api/marketing-handoffs/publish/files",
    headers: authHeadersSchema,
    body: uploadBodySchema,
    responses: { 200: marketingHandoffFileSchema, ...errors },
  },
});
