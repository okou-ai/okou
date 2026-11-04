import {
  array,
  boolean,
  email,
  iso,
  number,
  object,
  string,
  url,
  uuid,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { usagePackUsdSchema } from "../validators/billing";

/**
 * Org role enum
 */
export const orgRoleSchema = zEnum(["admin", "member"]);
export type OrgRole = zInfer<typeof orgRoleSchema>;

/**
 * Org member schema
 */
export const orgMemberSchema = object({
  userId: string(),
  email: string(),
  firstName: string().nullable(),
  lastName: string().nullable(),
  imageUrl: string(),
  role: orgRoleSchema,
  joinedAt: string(),
});
export type OrgMember = zInfer<typeof orgMemberSchema>;

/**
 * Pending invitation schema
 */
export const orgPendingInvitationSchema = object({
  id: string(),
  email: string(),
  role: orgRoleSchema,
  createdAt: string(),
  usagePackUsd: usagePackUsdSchema.optional(),
});
export type OrgPendingInvitation = zInfer<typeof orgPendingInvitationSchema>;

/**
 * Membership request schema
 */
export const orgMembershipRequestSchema = object({
  id: string(),
  userId: string(),
  email: string(),
  firstName: string().nullable(),
  lastName: string().nullable(),
  imageUrl: string(),
  createdAt: string(),
});
export type OrgMembershipRequest = zInfer<typeof orgMembershipRequestSchema>;

/**
 * Revoke invitation request schema
 */
export const revokeInvitationRequestSchema = object({
  invitationId: string(),
});
export type RevokeInvitationRequest = zInfer<
  typeof revokeInvitationRequestSchema
>;

/**
 * Membership request action schema
 */
export const membershipRequestActionSchema = object({
  requestId: string(),
});
export type MembershipRequestAction = zInfer<
  typeof membershipRequestActionSchema
>;

/**
 * Org members response schema (status + members list)
 */
export const orgMembersResponseSchema = object({
  name: string(),
  role: orgRoleSchema,
  members: array(orgMemberSchema),
  pendingInvitations: array(orgPendingInvitationSchema).optional(),
  membershipRequests: array(orgMembershipRequestSchema).optional(),
  createdAt: string(),
});
export type OrgMembersResponse = zInfer<typeof orgMembersResponseSchema>;

/**
 * Invite member request schema
 */
export const inviteOrgMemberRequestSchema = object({
  email: email(),
  role: orgRoleSchema.optional().default("member"),
});
export type InviteOrgMemberRequest = zInfer<
  typeof inviteOrgMemberRequestSchema
>;

export const previewOrgInvitationPurchaseRequestSchema =
  inviteOrgMemberRequestSchema.extend({
    usagePackUsd: usagePackUsdSchema,
    supportsInAppPreview: boolean().optional(),
    returnUrl: url().max(5000).optional(),
  });

export const orgInvitationPurchasePreviewResponseSchema = object({
  purchaseId: uuid(),
  usagePackUsd: usagePackUsdSchema,
  immediateAmountCents: number().int().nonnegative(),
  currency: string().length(3),
  purchasedCredits: number().int().nonnegative(),
  bonusCredits: number().int().nonnegative(),
  totalCredits: number().int().positive(),
  currentPeriodEnd: iso.datetime(),
  expiresAt: iso.datetime(),
  paymentMethodPreviewToken: string().min(1).optional(),
  checkoutUrl: url().optional(),
});
export type OrgInvitationPurchasePreviewResponse = zInfer<
  typeof orgInvitationPurchasePreviewResponseSchema
>;

/**
 * Remove member request schema
 */
export const removeOrgMemberRequestSchema = object({
  email: email(),
});
export type RemoveOrgMemberRequest = zInfer<
  typeof removeOrgMemberRequestSchema
>;

/**
 * Update member role request schema
 */
export const updateOrgMemberRoleRequestSchema = object({
  email: email(),
  role: orgRoleSchema,
});
export type UpdateOrgMemberRoleRequest = zInfer<
  typeof updateOrgMemberRoleRequestSchema
>;

/**
 * Simple message response schema
 */
export const orgMessageResponseSchema = object({
  message: string(),
});
export type OrgMessageResponse = zInfer<typeof orgMessageResponseSchema>;
