import * as z from "zod";
import { usagePackUsdSchema } from "./billing";

/**
 * Org role enum
 */
export const orgRoleSchema = z.enum(["admin", "member"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/**
 * Org member schema
 */
export const orgMemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  imageUrl: z.string(),
  role: orgRoleSchema,
  joinedAt: z.string(),
});
export type OrgMember = z.infer<typeof orgMemberSchema>;

/**
 * Pending invitation schema
 */
export const orgPendingInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  createdAt: z.string(),
  usagePackUsd: usagePackUsdSchema.optional(),
});
export type OrgPendingInvitation = z.infer<typeof orgPendingInvitationSchema>;

/**
 * Membership request schema
 */
export const orgMembershipRequestSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  imageUrl: z.string(),
  createdAt: z.string(),
});
export type OrgMembershipRequest = z.infer<typeof orgMembershipRequestSchema>;

/**
 * Revoke invitation request schema
 */
export const revokeInvitationRequestSchema = z.object({
  invitationId: z.string(),
});
export type RevokeInvitationRequest = z.infer<
  typeof revokeInvitationRequestSchema
>;

/**
 * Membership request action schema
 */
export const membershipRequestActionSchema = z.object({
  requestId: z.string(),
});
export type MembershipRequestAction = z.infer<
  typeof membershipRequestActionSchema
>;

/**
 * Org members response schema (status + members list)
 */
export const orgMembersResponseSchema = z.object({
  name: z.string(),
  role: orgRoleSchema,
  members: z.array(orgMemberSchema),
  pendingInvitations: z.array(orgPendingInvitationSchema).optional(),
  membershipRequests: z.array(orgMembershipRequestSchema).optional(),
  createdAt: z.string(),
});
export type OrgMembersResponse = z.infer<typeof orgMembersResponseSchema>;

/**
 * Invite member request schema
 */
export const inviteOrgMemberRequestSchema = z.object({
  email: z.string().email(),
  role: orgRoleSchema.optional().default("member"),
});
export type InviteOrgMemberRequest = z.infer<
  typeof inviteOrgMemberRequestSchema
>;

export const previewOrgInvitationPurchaseRequestSchema =
  inviteOrgMemberRequestSchema.extend({
    usagePackUsd: usagePackUsdSchema,
    supportsInAppPreview: z.boolean().optional(),
    returnUrl: z.string().url().max(5000).optional(),
  });

export const orgInvitationPurchasePreviewResponseSchema = z.object({
  purchaseId: z.uuid(),
  usagePackUsd: usagePackUsdSchema,
  immediateAmountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  purchasedCredits: z.number().int().nonnegative(),
  bonusCredits: z.number().int().nonnegative(),
  totalCredits: z.number().int().positive(),
  currentPeriodEnd: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  paymentMethodPreviewToken: z.string().min(1).optional(),
  checkoutUrl: z.string().url().optional(),
});
export type OrgInvitationPurchasePreviewResponse = z.infer<
  typeof orgInvitationPurchasePreviewResponseSchema
>;

/**
 * Remove member request schema
 */
export const removeOrgMemberRequestSchema = z.object({
  email: z.string().email(),
});
export type RemoveOrgMemberRequest = z.infer<
  typeof removeOrgMemberRequestSchema
>;

/**
 * Update member role request schema
 */
export const updateOrgMemberRoleRequestSchema = z.object({
  email: z.string().email(),
  role: orgRoleSchema,
});
export type UpdateOrgMemberRoleRequest = z.infer<
  typeof updateOrgMemberRoleRequestSchema
>;

/**
 * Simple message response schema
 */
export const orgMessageResponseSchema = z.object({
  message: z.string(),
});
export type OrgMessageResponse = z.infer<typeof orgMessageResponseSchema>;
