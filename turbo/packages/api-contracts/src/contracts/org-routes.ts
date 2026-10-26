import { literal, number, object } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import { orgResponseSchema, updateOrgRequestSchema } from "./orgs";
import { orgMessageResponseSchema } from "./org-members";

const c = initContract();

/**
 * Org contract for /api/org
 */
export const orgContract = c.router({
  get: {
    method: "GET",
    path: "/api/org",
    headers: authHeadersSchema,
    responses: {
      200: orgResponseSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
    },
    summary: "Get current org",
  },
  createdCount: {
    method: "GET",
    path: "/api/org/created-count",
    headers: authHeadersSchema,
    responses: {
      200: object({
        createdOrganizationsCount: number().int().nonnegative(),
      }),
      401: apiErrorSchema,
      403: apiErrorSchema,
      503: apiErrorSchema,
    },
    summary: "Get current user's created organization count",
  },
  update: {
    method: "PUT",
    path: "/api/org",
    headers: authHeadersSchema,
    body: updateOrgRequestSchema,
    responses: {
      200: orgResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update org profile",
  },
});

export type OrgContract = typeof orgContract;

/**
 * Org contract for POST /api/org/leave
 */
export const orgLeaveContract = c.router({
  leave: {
    method: "POST",
    path: "/api/org/leave",
    headers: authHeadersSchema,
    body: object({}),
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Leave the current org",
  },
});

export type OrgLeaveContract = typeof orgLeaveContract;

/**
 * Org contract for POST /api/org/delete
 */
export const orgDeleteContract = c.router({
  delete: {
    method: "POST",
    path: "/api/org/delete",
    headers: authHeadersSchema,
    body: object({ confirm: literal("confirm") }),
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Delete the current org",
  },
});

export type OrgDeleteContract = typeof orgDeleteContract;
