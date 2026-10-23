import * as z from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const c = initContract();

export const orgLogoResponseSchema = z.object({
  logoUrl: z.string().nullable(),
  hasImage: z.boolean(),
});

export type OrgLogoResponse = z.infer<typeof orgLogoResponseSchema>;

export const orgLogoContract = c.router({
  get: {
    method: "GET",
    path: "/api/org/logo",
    headers: authHeadersSchema,
    responses: {
      200: orgLogoResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get current organization logo",
  },
  post: {
    method: "POST",
    path: "/api/org/logo",
    headers: authHeadersSchema,
    contentType: "multipart/form-data",
    body: c.type<FormData>(),
    responses: {
      200: orgLogoResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Upload current organization logo",
  },
});

export type OrgLogoContract = typeof orgLogoContract;
