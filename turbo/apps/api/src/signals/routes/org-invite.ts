import {
  prepareGetStartedInvitation,
  linkGetStartedInvitation,
  revokeGetStartedInvitation,
} from "../services/get-started-invitation.service";
import { command } from "ccstate";
import type { UsagePackUsd } from "@okouai/api-contracts/contracts/billing";
import { orgInviteContract } from "@okouai/api-contracts/contracts/org-member-routes";
import type { OrgRole } from "@okouai/api-contracts/contracts/org-members";

import { env, optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import {
  badRequestMessage,
  conflict,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { requestSignal$ } from "../context/hono";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { parseBillingPaymentMethodPreviewToken } from "../services/billing-purchase-preview-token.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import {
  confirmUsagePackInvitationPurchase,
  createUsagePackInvitationPreview,
  revokeUsagePackInvitationPurchase,
  usagePackInvitationPurchaseSchemaAvailable,
  type UsagePackInvitationPurchaseConflictReason,
} from "../services/usage-pack-invitation-purchase.service";
import { activeUsagePackBillingContext } from "../services/usage-pack-subscription.service";
import {
  revalidateBillingPurchase,
  routeBillingPurchasePreview,
  type BillingPurchasePaymentMethod,
} from "../services/billing-payment-method.service";
import type { RouteEntry } from "../route-entry";
import { withBillingClerkRateLimit } from "./billing-clerk-rate-limit";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";

const log = logger("api:org-invite");

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Access denied",
      code: "FORBIDDEN",
    }),
  }),
});

const activePlanRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Reactivate your workspace plan to invite members",
      code: "FORBIDDEN",
    }),
  }),
});

type InvitationPurchaseErrorReason =
  | UsagePackInvitationPurchaseConflictReason
  | "preview_expired"
  | "preview_invalid"
  | "purchase_not_found"
  | "subscription_not_found";

interface InvitationPurchaseErrorDefinition {
  readonly status: 400 | 404 | 409;
  readonly code: string;
  readonly message: string;
}

const INVITATION_PURCHASE_ERRORS = {
  billing_period_ending: {
    status: 409,
    code: "INVITATION_PURCHASE_BILLING_PERIOD_ENDING",
    message:
      "This billing period is ending too soon to complete the purchase. Try again after it renews.",
  },
  billing_state_changed: {
    status: 409,
    code: "INVITATION_PURCHASE_BILLING_STATE_CHANGED",
    message:
      "Billing changed while this invitation was being purchased. Review the invitation and try again.",
  },
  invitee_unavailable: {
    status: 409,
    code: "INVITATION_PURCHASE_INVITEE_UNAVAILABLE",
    message: "This person is already a member or has a pending invitation.",
  },
  no_credits: {
    status: 409,
    code: "INVITATION_PURCHASE_NO_CREDITS",
    message:
      "This purchase would not add any credits. Choose a larger member package or try again after renewal.",
  },
  payment_method_changed: {
    status: 409,
    code: "INVITATION_PURCHASE_PAYMENT_METHOD_CHANGED",
    message: "Your payment method changed. Review the invitation again.",
  },
  preview_expired: {
    status: 400,
    code: "INVITATION_PURCHASE_PREVIEW_EXPIRED",
    message:
      "This invitation purchase preview expired. Review the invitation again.",
  },
  preview_invalid: {
    status: 409,
    code: "INVITATION_PURCHASE_PREVIEW_INVALID",
    message:
      "This invitation purchase preview is no longer valid. Review the invitation again.",
  },
  purchase_in_progress: {
    status: 409,
    code: "INVITATION_PURCHASE_IN_PROGRESS",
    message:
      "Another purchase for this invitation is already in progress. Wait a moment and try again.",
  },
  purchase_inactive: {
    status: 409,
    code: "INVITATION_PURCHASE_INACTIVE",
    message:
      "This invitation purchase is no longer active. Review the invitation again.",
  },
  purchase_not_found: {
    status: 404,
    code: "INVITATION_PURCHASE_NOT_FOUND",
    message:
      "Invitation purchase not found. Review the invitation and try again.",
  },
  subscription_canceling: {
    status: 409,
    code: "INVITATION_PURCHASE_SUBSCRIPTION_CANCELING",
    message: "Restore your subscription before purchasing a member package.",
  },
  subscription_changed: {
    status: 409,
    code: "INVITATION_PURCHASE_SUBSCRIPTION_CHANGED",
    message:
      "Your usage pack subscription changed. Review the invitation again.",
  },
  subscription_not_found: {
    status: 404,
    code: "INVITATION_PURCHASE_SUBSCRIPTION_NOT_FOUND",
    message:
      "Usage pack subscription not found. Review your billing settings and try again.",
  },
  subscription_unavailable: {
    status: 409,
    code: "INVITATION_PURCHASE_SUBSCRIPTION_UNAVAILABLE",
    message:
      "Your usage pack subscription is no longer available. Review your billing settings and try again.",
  },
} satisfies Readonly<
  Record<InvitationPurchaseErrorReason, InvitationPurchaseErrorDefinition>
>;

function invitationPurchaseError(args: {
  readonly phase: "preview" | "confirm";
  readonly reason: InvitationPurchaseErrorReason;
  readonly orgId: string;
  readonly purchaseId?: string;
  readonly usagePackUsd?: UsagePackUsd;
  readonly role?: OrgRole;
  readonly diagnostics?: Readonly<
    Record<string, string | number | boolean | null>
  >;
}) {
  const error = INVITATION_PURCHASE_ERRORS[args.reason];
  log.debug("Usage pack invitation purchase rejected", {
    ...args.diagnostics,
    type: "usage_pack_invitation_purchase_rejected",
    phase: args.phase,
    reason: args.reason,
    errorCode: error.code,
    orgId: args.orgId,
    ...(args.purchaseId ? { purchaseId: args.purchaseId } : {}),
    ...(args.usagePackUsd ? { usagePackUsd: args.usagePackUsd } : {}),
    ...(args.role ? { role: args.role } : {}),
  });
  return {
    status: error.status,
    body: {
      error: {
        message: error.message,
        code: error.code,
      },
    },
  };
}

const inviteBody$ = bodyResultOf(orgInviteContract.invite);

const inviteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const body = await get(inviteBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const db = get(db$);
  const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
  signal.throwIfAborted();
  if (capabilities?.status !== "active") {
    return activePlanRequired;
  }

  // Clerk side effect: sends the invitation email server-side.
  const client = get(clerk$);
  const rewardClaim = await prepareGetStartedInvitation(set(writeDb$), {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  const invitation = await client.organizations.createOrganizationInvitation({
    organizationId: auth.orgId,
    emailAddress: body.data.email,
    inviterUserId: auth.userId,
    role: body.data.role === "admin" ? "org:admin" : "org:member",
    redirectUrl: env("APP_URL"),
    ...(rewardClaim
      ? { privateMetadata: { getStartedClaimId: rewardClaim.id } }
      : {}),
  });
  signal.throwIfAborted();
  if (rewardClaim) {
    await linkGetStartedInvitation(
      set(writeDb$),
      rewardClaim.id,
      invitation.id,
    );
  }
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { message: `Invitation sent to ${body.data.email}` },
  };
});

const revokeBody$ = bodyResultOf(orgInviteContract.revoke);

const revokeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const body = await get(revokeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const client = get(clerk$);
  const readDb = get(db$);
  if (await usagePackInvitationPurchaseSchemaAvailable(readDb)) {
    signal.throwIfAborted();
    const result = await revokeUsagePackInvitationPurchase(
      set(writeDb$),
      client,
      {
        orgId: auth.orgId,
        invitationId: body.data.invitationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "accepted") {
      return conflict("The invitation has already been accepted");
    }
    if (result.status === "revoked") {
      await revokeGetStartedInvitation(set(writeDb$), {
        orgId: auth.orgId,
        invitationId: body.data.invitationId,
      });
      signal.throwIfAborted();
      return {
        status: 200 as const,
        body: { message: "Invitation revoked and refund initiated" },
      };
    }
  }

  // Legacy invitations remain a direct Clerk operation.
  await client.organizations.revokeOrganizationInvitation({
    organizationId: auth.orgId,
    invitationId: body.data.invitationId,
  });
  signal.throwIfAborted();
  await revokeGetStartedInvitation(set(writeDb$), {
    orgId: auth.orgId,
    invitationId: body.data.invitationId,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { message: "Invitation revoked" },
  };
});

const purchasePreviewBody$ = bodyResultOf(orgInviteContract.previewPurchase);

const purchasePreviewInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    signal.throwIfAborted();
    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    if (capabilities?.status !== "active") {
      return activePlanRequired;
    }
    if (!(await usagePackInvitationPurchaseSchemaAvailable(db))) {
      return providerUnavailable("Usage pack invitations are not ready");
    }
    signal.throwIfAborted();
    const body = await get(purchasePreviewBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const previewEnabled = body.data.supportsInAppPreview === true;
    if (
      previewEnabled &&
      (!body.data.returnUrl || !billingRedirectAllowed(body.data.returnUrl))
    ) {
      return badRequestMessage(
        "returnUrl must match the platform origin for in-app billing",
      );
    }
    const readSignal = AbortSignal.any([signal, get(requestSignal$)]);
    const result = await createUsagePackInvitationPreview(
      set(writeDb$),
      get(clerk$),
      {
        orgId: auth.orgId,
        inviterUserId: auth.userId,
        email: body.data.email,
        role: body.data.role,
        usagePackUsd: body.data.usagePackUsd,
        publicBrand: PUBLIC_BRAND,
      },
      readSignal,
    );
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    if (result.status === "not_found") {
      return invitationPurchaseError({
        phase: "preview",
        reason: "subscription_not_found",
        orgId: auth.orgId,
        usagePackUsd: body.data.usagePackUsd,
        role: body.data.role,
      });
    }
    if (result.status === "conflict") {
      return invitationPurchaseError({
        phase: "preview",
        reason: result.reason,
        orgId: auth.orgId,
        usagePackUsd: body.data.usagePackUsd,
        role: body.data.role,
        diagnostics: result.diagnostics,
      });
    }
    if (previewEnabled && body.data.returnUrl) {
      const billing = await activeUsagePackBillingContext(db, auth.orgId);
      signal.throwIfAborted();
      if (!billing) {
        return invitationPurchaseError({
          phase: "preview",
          reason: "subscription_not_found",
          orgId: auth.orgId,
          purchaseId: result.preview.purchaseId,
          usagePackUsd: body.data.usagePackUsd,
          role: body.data.role,
        });
      }
      const route = await routeBillingPurchasePreview(
        {
          stripe: getStripeClient(),
          orgId: auth.orgId,
          customerId: billing.stripeCustomerId,
          subscriptionId: billing.stripeSubscriptionId,
          operation: "usage_pack_invitation",
          operationId: result.preview.purchaseId,
          returnUrl: body.data.returnUrl,
        },
        signal,
      );
      return {
        status: 200 as const,
        body: {
          ...result.preview,
          ...(route.paymentMethodPreviewToken
            ? { paymentMethodPreviewToken: route.paymentMethodPreviewToken }
            : {}),
        },
      };
    }
    return { status: 200 as const, body: result.preview };
  },
);

async function revalidateInvitationPurchasePreview(
  args: {
    readonly db: ReadonlyDb;
    readonly orgId: string;
    readonly purchaseId: string;
    readonly paymentMethodPreviewToken: string;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "continue";
      readonly paymentMethod?: BillingPurchasePaymentMethod;
    }
  | { readonly kind: "invalid_preview" }
> {
  const preview = parseBillingPaymentMethodPreviewToken(
    args.paymentMethodPreviewToken,
  );
  const billing = await activeUsagePackBillingContext(args.db, args.orgId);
  signal.throwIfAborted();
  if (
    !preview ||
    !billing ||
    preview.operation !== "usage_pack_invitation" ||
    preview.operationId !== args.purchaseId ||
    preview.orgId !== args.orgId ||
    preview.customerId !== billing.stripeCustomerId ||
    preview.subscriptionId !== billing.stripeSubscriptionId ||
    new Date(preview.expiresAt) <= nowDate()
  ) {
    return { kind: "invalid_preview" };
  }
  const revalidated = await revalidateBillingPurchase(
    {
      stripe: getStripeClient(),
      orgId: args.orgId,
      customerId: preview.customerId,
      subscriptionId: preview.subscriptionId,
      paymentMethodId: preview.paymentMethodId,
      operation: preview.operation,
      operationId: preview.operationId,
      returnUrl: preview.returnUrl,
    },
    signal,
  );
  if (revalidated.kind === "invalid_preview") {
    return { kind: "invalid_preview" };
  }
  return revalidated.kind === "hosted_invoice"
    ? { kind: "continue" }
    : { kind: "continue", paymentMethod: revalidated };
}

const purchaseConfirmInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    signal.throwIfAborted();
    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    if (capabilities?.status !== "active") {
      return activePlanRequired;
    }
    if (!(await usagePackInvitationPurchaseSchemaAvailable(db))) {
      return providerUnavailable("Usage pack invitations are not ready");
    }
    const body = await get(bodyResultOf(orgInviteContract.confirmPurchase));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const { purchaseId } = get(pathParamsOf(orgInviteContract.confirmPurchase));
    let paymentMethod: BillingPurchasePaymentMethod | undefined;
    if (body.data.paymentMethodPreviewToken) {
      const revalidated = await revalidateInvitationPurchasePreview(
        {
          db,
          orgId: auth.orgId,
          purchaseId,
          paymentMethodPreviewToken: body.data.paymentMethodPreviewToken,
        },
        signal,
      );
      if (revalidated.kind === "invalid_preview") {
        return invitationPurchaseError({
          phase: "confirm",
          reason: "preview_invalid",
          orgId: auth.orgId,
          purchaseId,
        });
      }
      paymentMethod = revalidated.paymentMethod;
    }
    const readSignal = AbortSignal.any([signal, get(requestSignal$)]);
    const result = await confirmUsagePackInvitationPurchase(
      set(writeDb$),
      get(clerk$),
      { orgId: auth.orgId, purchaseId, paymentMethod },
      readSignal,
    );
    signal.throwIfAborted();
    readSignal.throwIfAborted();
    if (result.status === "not_found") {
      return invitationPurchaseError({
        phase: "confirm",
        reason: "purchase_not_found",
        orgId: auth.orgId,
        purchaseId,
      });
    }
    if (result.status === "expired") {
      return invitationPurchaseError({
        phase: "confirm",
        reason: "preview_expired",
        orgId: auth.orgId,
        purchaseId,
      });
    }
    if (result.status === "conflict") {
      return invitationPurchaseError({
        phase: "confirm",
        reason: result.reason,
        orgId: auth.orgId,
        purchaseId,
        diagnostics: result.diagnostics,
      });
    }
    if (result.status === "pending_payment") {
      return {
        status: 200 as const,
        body: {
          status: "pending_payment" as const,
          hostedInvoiceUrl: result.hostedInvoiceUrl,
        },
      };
    }
    return {
      status: 200 as const,
      body: { message: "Invitation purchased and sent" },
    };
  },
);

export const orgInviteRoutes: readonly RouteEntry[] = [
  {
    route: orgInviteContract.invite,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      inviteInner$,
    ),
  },
  {
    route: orgInviteContract.revoke,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      revokeInner$,
    ),
  },
  {
    route: orgInviteContract.previewPurchase,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      withBillingClerkRateLimit(purchasePreviewInner$),
    ),
  },
  {
    route: orgInviteContract.confirmPurchase,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      withBillingClerkRateLimit(purchaseConfirmInner$),
    ),
  },
];
