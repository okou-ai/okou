import { array, object, string, uuid, type infer as zInfer } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { hostedSiteShareEmailSchema } from "../validators/hosted-site-sharing";

export const hostedSiteShareSchema = object({
  id: uuid(),
  email: hostedSiteShareEmailSchema,
});
export const hostedSiteShareAccountSchema = object({
  userId: string(),
  email: hostedSiteShareEmailSchema,
  name: string().nullable(),
});
export type HostedSiteShareAccount = zInfer<
  typeof hostedSiteShareAccountSchema
>;

const c = initContract();
const pathParams = object({ siteId: uuid() });
const errors = {
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
};
export const hostedSiteSharingContract = c.router({
  list: {
    method: "GET",
    path: "/api/host/sites/:siteId/shares",
    pathParams,
    headers: authHeadersSchema,
    responses: {
      200: object({ shares: array(hostedSiteShareSchema) }),
      ...errors,
    },
    summary: "List an owned website's named viewers and invitations",
  },
  search: {
    method: "GET",
    path: "/api/host/sites/:siteId/share-accounts",
    pathParams,
    headers: authHeadersSchema,
    query: object({ query: string().trim().min(2).max(254) }),
    responses: {
      200: object({ accounts: array(hostedSiteShareAccountSchema) }),
      400: apiErrorSchema,
      429: apiErrorSchema,
      ...errors,
    },
    summary: "Search current workspace members to share an owned website with",
  },
  share: {
    method: "POST",
    path: "/api/host/sites/:siteId/shares",
    pathParams,
    headers: authHeadersSchema,
    body: object({ email: hostedSiteShareEmailSchema }),
    responses: {
      200: object({
        share: hostedSiteShareSchema,
      }),
      400: apiErrorSchema,
      429: apiErrorSchema,
      ...errors,
    },
    summary:
      "Grant an existing account access or email an invitation to a website",
  },
  remove: {
    method: "DELETE",
    path: "/api/host/sites/:siteId/shares/:shareId",
    pathParams: pathParams.extend({ shareId: uuid() }),
    headers: authHeadersSchema,
    body: c.noBody(),
    responses: { 200: object({ removed: uuid() }), ...errors },
    summary: "Remove a website's named viewer or pending invitation",
  },
});
