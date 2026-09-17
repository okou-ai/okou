import { z } from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";
import {
  orgMembersResponseSchema,
  inviteOrgMemberRequestSchema,
  removeOrgMemberRequestSchema,
  updateOrgMemberRoleRequestSchema,
  revokeInvitationRequestSchema,
  membershipRequestActionSchema,
  orgMessageResponseSchema,
  orgInvitationPurchasePreviewResponseSchema,
  previewOrgInvitationPurchaseRequestSchema,
} from "./org-members";

const c = initContract();

const invitationPurchaseConfirmResponseSchema = z.union([
  orgMessageResponseSchema,
  z.object({
    status: z.literal("pending_payment"),
    hostedInvoiceUrl: z.string().url(),
    message: z.string().optional(),
  }),
  z.object({
    status: z.literal("checkout_required"),
    checkoutUrl: z.string().url(),
    message: z.string().optional(),
  }),
]);

/**
 * Org contract for /api/org/members
 */
export const orgMembersContract = c.router({
  members: {
    method: "GET",
    path: "/api/org/members",
    headers: authHeadersSchema,
    query: z.object({
      view: z.literal("members").optional(),
    }),
    responses: {
      200: orgMembersResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Get org members, optionally without invitation and request data",
  },
  updateRole: {
    method: "PATCH",
    path: "/api/org/members",
    headers: authHeadersSchema,
    body: updateOrgMemberRoleRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Update a member's role",
  },
  removeMember: {
    method: "DELETE",
    path: "/api/org/members",
    headers: authHeadersSchema,
    body: removeOrgMemberRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Remove a member from the org",
  },
});

export type OrgMembersContract = typeof orgMembersContract;

/**
 * Org contract for POST /api/org/invite
 */
export const orgInviteContract = c.router({
  invite: {
    method: "POST",
    path: "/api/org/invite",
    headers: authHeadersSchema,
    body: inviteOrgMemberRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Invite a member to the org",
  },
  previewPurchase: {
    method: "POST",
    path: "/api/org/invite/purchase/preview",
    headers: authHeadersSchema,
    body: previewOrgInvitationPurchaseRequestSchema,
    responses: {
      200: orgInvitationPurchasePreviewResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Preview a prorated usage pack purchase for an org invitation",
  },
  confirmPurchase: {
    method: "POST",
    path: "/api/org/invite/purchase/:purchaseId/confirm",
    pathParams: z.object({ purchaseId: z.uuid() }),
    headers: authHeadersSchema,
    body: z.object({
      paymentMethodPreviewToken: z.string().min(1).optional(),
    }),
    responses: {
      200: invitationPurchaseConfirmResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      404: apiErrorSchema,
      409: apiErrorSchema,
      503: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Confirm an org invitation usage pack purchase",
  },
  revoke: {
    method: "DELETE",
    path: "/api/org/invite",
    headers: authHeadersSchema,
    body: revokeInvitationRequestSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      409: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Revoke a pending invitation",
  },
});

export type OrgInviteContract = typeof orgInviteContract;

/**
 * Org contract for /api/org/membership-requests
 */
export const orgMembershipRequestsContract = c.router({
  accept: {
    method: "POST",
    path: "/api/org/membership-requests",
    headers: authHeadersSchema,
    body: membershipRequestActionSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Accept a membership request",
  },
  reject: {
    method: "DELETE",
    path: "/api/org/membership-requests",
    headers: authHeadersSchema,
    body: membershipRequestActionSchema,
    responses: {
      200: orgMessageResponseSchema,
      400: apiErrorSchema,
      401: apiErrorSchema,
      403: apiErrorSchema,
      500: apiErrorSchema,
    },
    summary: "Reject a membership request",
  },
});

export type OrgMembershipRequestsContract =
  typeof orgMembershipRequestsContract;
