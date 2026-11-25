import {
  array,
  enum as zEnum,
  object,
  string,
  uuid,
  type infer as zInfer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  hostedSiteShareAccountSchema,
  hostedSiteShareSchema,
} from "./hosted-site-sharing";
import { hostedSiteShareEmailSchema } from "../validators/hosted-site-sharing";

export const artifactSharingResourceSchema = object({
  kind: zEnum(["file", "site"]),
  id: uuid(),
});
export type ArtifactSharingTarget = zInfer<
  typeof artifactSharingResourceSchema
>;
const c = initContract();
const errors = {
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
};
const limited = { ...errors, 400: apiErrorSchema, 429: apiErrorSchema };
const path = "/api/artifact-sharing/:kind/:id";

export const artifactSharingContract = c.router({
  list: {
    method: "GET",
    path: `${path}/shares`,
    pathParams: artifactSharingResourceSchema,
    headers: authHeadersSchema,
    responses: {
      200: object({ shares: array(hostedSiteShareSchema) }),
      ...errors,
    },
    summary: "List named viewers of an owned file or website",
  },
  search: {
    method: "GET",
    path: `${path}/share-accounts`,
    pathParams: artifactSharingResourceSchema,
    headers: authHeadersSchema,
    query: object({ query: string().trim().min(2).max(254) }),
    responses: {
      200: object({ accounts: array(hostedSiteShareAccountSchema) }),
      ...limited,
    },
    summary: "Search current workspace members for artifact sharing",
  },
  share: {
    method: "POST",
    path: `${path}/shares`,
    pathParams: artifactSharingResourceSchema,
    headers: authHeadersSchema,
    body: object({ email: hostedSiteShareEmailSchema }),
    responses: { 200: object({ share: hostedSiteShareSchema }), ...limited },
    summary: "Grant access or process an email invitation to an owned artifact",
  },
  remove: {
    method: "DELETE",
    path: `${path}/shares/:shareId`,
    pathParams: artifactSharingResourceSchema.extend({ shareId: uuid() }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: { 200: object({ removed: uuid() }), ...errors },
    summary: "Remove a named artifact viewer or invitation",
  },
});
