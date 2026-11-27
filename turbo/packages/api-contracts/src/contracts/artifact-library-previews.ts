import { array, object, string, uuid, type infer as zInfer } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const previewSchema = object({
  artifactId: uuid(),
  url: string(),
  expiresAt: string(),
  contentType: string(),
});

export type ArtifactLibraryPreview = zInfer<typeof previewSchema>;

export const artifactLibraryPreviewsContract = initContract().router({
  resolve: {
    method: "POST",
    path: "/api/artifacts/catalog/previews",
    headers: authHeadersSchema,
    body: object({ artifactIds: array(uuid()).min(1).max(60) }),
    responses: {
      200: object({ previews: array(previewSchema) }),
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
    },
    summary: "Resolve owned Artifact Library covers in one batch",
  },
});
