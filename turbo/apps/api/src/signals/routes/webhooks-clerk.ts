import { webhookClerkContract } from "@okouai/api-contracts/contracts/webhooks";
import { orgCache } from "@okouai/db/schema/org-cache";
import { command } from "ccstate";

import { optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import { isLockNotAvailable } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { request$ } from "../context/hono";
import { type ClerkWebhookEvent, verifyClerkWebhook } from "../external/clerk";
import { waitUntil } from "../context/wait-until";
import { type Db, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { settle, tapError } from "../utils";
import { ensureOrgLimitedFreeBootstrap$ } from "../services/org-limited-free-bootstrap.service";
import {
  cleanupClerkBannedUser$,
  cleanupClerkDeletedOrgBilling$,
  cleanupClerkDeletedOrgMembership$,
  cleanupClerkDeletedOrg$,
  cleanupClerkDeletedUser$,
} from "../services/webhooks-clerk-cleanup.service";
import { handleUsagePackInvitationAccepted } from "../services/usage-pack-invitation-purchase.service";
import { recordMorningBriefMembership } from "../services/morning-brief-enrollment-data.service";
import {
  ensureMorningBriefDefaultEnabled$,
  type EnsureMorningBriefDefaultEnabledResult,
} from "../services/morning-brief-preference.service";
import {
  deliverWelcomeChatThread$,
  type WelcomeThreadDeliveryOutcome,
} from "../services/welcome-chat-thread.service";

const L = logger("WebhookClerkRoute");

function jsonError(message: string, status: 401 | 503): Response {
  return Response.json({ error: message }, { status });
}

function eventDataId(data: unknown): string | undefined {
  if (
    typeof data === "object" &&
    data !== null &&
    "id" in data &&
    typeof data.id === "string"
  ) {
    return data.id;
  }
  return undefined;
}

function propertyOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function stringPropertyOf(value: unknown, key: string): string | undefined {
  const property = propertyOf(value, key);
  return typeof property === "string" ? property : undefined;
}

function numberPropertyOf(value: unknown, key: string): number | undefined {
  const property = propertyOf(value, key);
  return typeof property === "number" && Number.isFinite(property)
    ? property
    : undefined;
}

function organizationMembershipIdentity(data: unknown):
  | {
      readonly orgId: string;
      readonly userId: string;
      readonly membershipId?: string;
      readonly role?: string;
      readonly purchaseId?: string;
      readonly createdAt?: Date;
    }
  | undefined {
  const organization = propertyOf(data, "organization");
  const orgId =
    stringPropertyOf(organization, "id") ??
    stringPropertyOf(data, "organization_id");
  const publicUserData =
    propertyOf(data, "publicUserData") ?? propertyOf(data, "public_user_data");
  const userId =
    stringPropertyOf(publicUserData, "userId") ??
    stringPropertyOf(publicUserData, "user_id") ??
    stringPropertyOf(data, "user_id");
  const role = stringPropertyOf(data, "role");
  const privateMetadata =
    propertyOf(data, "privateMetadata") ?? propertyOf(data, "private_metadata");
  const purchaseId = stringPropertyOf(
    privateMetadata,
    "usagePackInvitationPurchaseId",
  );
  const createdAt =
    numberPropertyOf(data, "createdAt") ?? numberPropertyOf(data, "created_at");

  return orgId && userId
    ? {
        orgId,
        userId,
        role,
        membershipId: eventDataId(data),
        ...(purchaseId ? { purchaseId } : {}),
        ...(createdAt === undefined ? {} : { createdAt: new Date(createdAt) }),
      }
    : undefined;
}

function organizationCreatedIdentity(data: unknown):
  | {
      readonly orgId: string;
      readonly userId: string;
      readonly createdAt: Date;
    }
  | undefined {
  const orgId = eventDataId(data);
  const userId =
    stringPropertyOf(data, "createdBy") ??
    stringPropertyOf(data, "created_by") ??
    stringPropertyOf(data, "createdByUserId") ??
    stringPropertyOf(data, "created_by_user_id");
  const createdAtMilliseconds =
    numberPropertyOf(data, "createdAt") ?? numberPropertyOf(data, "created_at");
  const createdAt =
    createdAtMilliseconds === undefined
      ? undefined
      : new Date(createdAtMilliseconds);

  return orgId && userId && createdAt && Number.isFinite(createdAt.getTime())
    ? { orgId, userId, createdAt }
    : undefined;
}

function isAdminMembershipRole(role: string | undefined): boolean {
  return role === "org:admin" || role === "admin";
}

function enqueueOrgBootstrap(args: {
  readonly eventType: string;
  readonly orgId: string;
  readonly userId: string;
  readonly task: Promise<unknown>;
}): void {
  waitUntil(
    tapError(args.task, (error) => {
      L.error(`${args.eventType} bootstrap failed`, {
        orgId: args.orgId,
        userId: args.userId,
        error,
      });
    }),
  );
}

async function observeNewMembershipMorningBriefProvisioning(
  identity: NonNullable<ReturnType<typeof organizationMembershipIdentity>> & {
    readonly createdAt: Date;
  },
  task: Promise<EnsureMorningBriefDefaultEnabledResult>,
): Promise<void> {
  const provisioning = await task;
  const details = {
    orgId: identity.orgId,
    userId: identity.userId,
    provisioning,
  };
  if (provisioning.outcome === "failed") {
    L.warn("Morning Brief membership provisioning outcome", details);
    return;
  }
  L.info("Morning Brief membership provisioning outcome", details);
}

function enqueueMorningBriefMembershipProvisioning(args: {
  readonly identity: NonNullable<
    ReturnType<typeof organizationMembershipIdentity>
  > & { readonly createdAt: Date };
  readonly task: Promise<EnsureMorningBriefDefaultEnabledResult>;
}): void {
  const identity = args.identity;
  waitUntil(
    tapError(
      observeNewMembershipMorningBriefProvisioning(identity, args.task),
      (error) => {
        L.error("Morning Brief membership provisioning failed", {
          orgId: identity.orgId,
          userId: identity.userId,
          error,
        });
      },
    ),
  );
}

interface WelcomeThreadDelivery {
  readonly trigger: string;
  readonly orgId: string;
  readonly userId: string;
  readonly task: Promise<WelcomeThreadDeliveryOutcome>;
}

async function observeWelcomeThreadDelivery(
  args: WelcomeThreadDelivery,
): Promise<void> {
  const delivery = await args.task;
  L.debug("welcome thread delivery outcome", {
    trigger: args.trigger,
    orgId: args.orgId,
    userId: args.userId,
    delivery,
  });
}

/**
 * Welcome delivery is a one-shot registration side effect, guarded like the
 * other bootstrap work here: the handler answers 200 either way, a failure
 * cannot block Morning Brief enrollment or org bootstrap, and a workspace that
 * is not ready is logged and abandoned rather than retried.
 */
function enqueueWelcomeThreadDelivery(args: WelcomeThreadDelivery): void {
  waitUntil(
    tapError(observeWelcomeThreadDelivery(args), (error) => {
      L.error(`${args.trigger} welcome thread delivery failed`, {
        orgId: args.orgId,
        userId: args.userId,
        error,
      });
    }),
  );
}

function organizationInvitationAcceptedIdentity(data: unknown):
  | {
      readonly orgId: string;
      readonly invitationId: string;
      readonly userId: string;
      readonly acceptedAt: Date;
      readonly normalizedEmail: string;
      readonly purchaseId?: string;
    }
  | undefined {
  const orgId = stringPropertyOf(data, "organization_id");
  const invitationId = eventDataId(data);
  const userId = stringPropertyOf(data, "user_id");
  const normalizedEmail = stringPropertyOf(data, "email_address");
  const updatedAt = numberPropertyOf(data, "updated_at");
  const purchaseId = stringPropertyOf(
    propertyOf(data, "private_metadata"),
    "usagePackInvitationPurchaseId",
  );

  return orgId && invitationId && userId && normalizedEmail && updatedAt
    ? {
        orgId,
        invitationId,
        userId,
        acceptedAt: new Date(updatedAt),
        normalizedEmail,
        ...(purchaseId ? { purchaseId } : {}),
      }
    : undefined;
}

interface UsagePackInvitationAcceptanceIdentity {
  readonly orgId: string;
  readonly invitationId?: string;
  readonly userId: string;
  readonly acceptedAt: Date;
  readonly normalizedEmail?: string;
  readonly purchaseId?: string;
}

function enqueueUsagePackInvitationAcceptance(
  eventType:
    | "organizationInvitation.accepted"
    | "organizationMembership.created",
  identity: UsagePackInvitationAcceptanceIdentity,
  db: Db,
  signal: AbortSignal,
): void {
  waitUntil(
    tapError(
      handleUsagePackInvitationAccepted(db, identity, signal),
      (error) => {
        L.error(`${eventType} activation failed`, {
          orgId: identity.orgId,
          invitationId: identity.invitationId,
          purchaseId: identity.purchaseId,
          userId: identity.userId,
          error,
        });
      },
    ),
  );
}

function enqueueUsagePackMembershipAcceptance(
  identity: NonNullable<ReturnType<typeof organizationMembershipIdentity>>,
  purchaseId: string,
  db: Db,
  signal: AbortSignal,
): void {
  if (!identity.createdAt) {
    L.error(
      "organizationMembership.created paid invitation missing creation time",
      {
        orgId: identity.orgId,
        userId: identity.userId,
        purchaseId,
      },
    );
    return;
  }
  enqueueUsagePackInvitationAcceptance(
    "organizationMembership.created",
    {
      orgId: identity.orgId,
      userId: identity.userId,
      acceptedAt: identity.createdAt,
      purchaseId,
    },
    db,
    signal,
  );
}

function handleOrganizationInvitationAcceptedWebhook(
  data: unknown,
  db: Db,
  signal: AbortSignal,
): Response {
  const identity = organizationInvitationAcceptedIdentity(data);
  if (!identity) {
    L.error("organizationInvitation.accepted event missing identity", { data });
    return new Response("OK", { status: 200 });
  }
  enqueueUsagePackInvitationAcceptance(
    "organizationInvitation.accepted",
    identity,
    db,
    signal,
  );
  return new Response("OK", { status: 200 });
}

interface OrganizationMembershipSideEffects {
  readonly bootstrap: (
    identity: NonNullable<ReturnType<typeof organizationMembershipIdentity>>,
  ) => void;
  readonly provisionMorningBrief: (
    identity: NonNullable<ReturnType<typeof organizationMembershipIdentity>>,
  ) => Promise<void>;
  readonly deliverWelcomeThread: (
    identity: NonNullable<ReturnType<typeof organizationMembershipIdentity>>,
  ) => void;
}

async function handleOrganizationMembershipCreatedWebhook(
  data: unknown,
  db: Db,
  signal: AbortSignal,
  sideEffects: OrganizationMembershipSideEffects,
): Promise<Response> {
  const identity = organizationMembershipIdentity(data);
  if (!identity) {
    L.error("organizationMembership.created event missing org/user ID", {
      data,
    });
    return new Response("OK", { status: 200 });
  }

  if (identity.purchaseId) {
    enqueueUsagePackMembershipAcceptance(
      identity,
      identity.purchaseId,
      db,
      signal,
    );
  }

  await sideEffects.provisionMorningBrief(identity);

  // Every new member is owed a welcome, so this runs before the admin-only
  // bootstrap below. An invited member joins a workspace whose default agent
  // already exists; a creator's own membership usually arrives before that
  // agent does, and bootstrap completion delivers theirs instead.
  sideEffects.deliverWelcomeThread(identity);

  if (!isAdminMembershipRole(identity.role)) {
    if (!identity.purchaseId) {
      L.debug("ignoring non-admin organizationMembership.created event", {
        orgId: identity.orgId,
        userId: identity.userId,
        role: identity.role,
      });
    }
    return new Response("OK", { status: 200 });
  }

  sideEffects.bootstrap(identity);
  return new Response("OK", { status: 200 });
}

async function verifiedClerkWebhook(
  request: Request,
): Promise<ClerkWebhookEvent | undefined> {
  const signingSecret = optionalEnv("CLERK_WEBHOOK_SIGNING_SECRET");
  return await tapError(verifyClerkWebhook(request.clone(), { signingSecret }));
}

function missingOrganizationDeletedIdResponse(data: unknown): Response {
  L.error("organization.deleted event missing org ID", { data });
  return new Response("OK", { status: 200 });
}

const handleOrganizationDeletedWebhook$ = command(
  async ({ set }, orgId: string, signal: AbortSignal): Promise<Response> => {
    const billingCleanup = await settle(
      set(cleanupClerkDeletedOrgBilling$, orgId, signal),
      signal,
    );
    if (!billingCleanup.ok) {
      L.error("organization.deleted billing cleanup failed", {
        orgId,
        error: billingCleanup.error,
      });
      return jsonError("Organization billing cleanup failed", 503);
    }

    waitUntil(
      tapError(set(cleanupClerkDeletedOrg$, orgId, signal), (error) => {
        L.error("organization.deleted cleanup failed", { orgId, error });
        if (isLockNotAvailable(error)) {
          throw error;
        }
      }),
    );
    return new Response("OK", { status: 200 });
  },
);

/**
 * A new workspace's default agent only becomes usable when bootstrap
 * publishes it, which is after its creator's membership event has already
 * passed. Deliver the creator's welcome here, where the workspace is finally
 * able to answer for one. The identity-derived thread id makes the second
 * trigger for an already-served recipient a no-op.
 */
const bootstrapOrgAndDeliverWelcome$ = command(
  async (
    { set },
    args: {
      readonly eventType: string;
      readonly orgId: string;
      readonly userId: string;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const bootstrap = await set(
      ensureOrgLimitedFreeBootstrap$,
      { orgId: args.orgId, ownerUserId: args.userId },
      signal,
    );
    signal.throwIfAborted();
    if (!bootstrap.agentId) {
      return;
    }
    enqueueWelcomeThreadDelivery({
      trigger: args.eventType,
      orgId: args.orgId,
      userId: args.userId,
      task: set(
        deliverWelcomeChatThread$,
        { orgId: args.orgId, userId: args.userId },
        signal,
      ),
    });
  },
);

const handleOrganizationCreatedWebhook$ = command(
  async ({ set }, data: unknown, signal: AbortSignal): Promise<Response> => {
    const identity = organizationCreatedIdentity(data);
    if (!identity) {
      L.error(
        "organization.created event missing org/creator user ID or creation time",
        { data },
      );
      return new Response("OK", { status: 200 });
    }

    enqueueOrgBootstrap({
      eventType: "organization.created",
      orgId: identity.orgId,
      userId: identity.userId,
      task: set(
        bootstrapOrgAndDeliverWelcome$,
        {
          eventType: "organization.created",
          orgId: identity.orgId,
          userId: identity.userId,
        },
        signal,
      ),
    });

    const name = stringPropertyOf(data, "name");
    if (name?.trim()) {
      await set(writeDb$)
        .insert(orgCache)
        .values({
          orgId: identity.orgId,
          name,
          createdBy: identity.userId,
          cachedAt: nowDate(),
        })
        // A duplicate or delayed creation event must not undo a rename.
        .onConflictDoNothing({ target: orgCache.orgId });
      signal.throwIfAborted();
    }
    return new Response("OK", { status: 200 });
  },
);

const enrollMorningBriefMembership$ = command(
  async (
    { set },
    identity: NonNullable<ReturnType<typeof organizationMembershipIdentity>>,
    signal: AbortSignal,
  ): Promise<void> => {
    const createdAt = identity.createdAt;
    if (
      !identity.membershipId ||
      !createdAt ||
      !Number.isFinite(createdAt.getTime())
    ) {
      L.error(
        "organizationMembership.created event missing valid creation time",
        {
          orgId: identity.orgId,
          userId: identity.userId,
        },
      );
      return;
    }
    await recordMorningBriefMembership(set(writeDb$), {
      orgId: identity.orgId,
      userId: identity.userId,
      membershipId: identity.membershipId,
      createdAt,
    });
    signal.throwIfAborted();
    enqueueMorningBriefMembershipProvisioning({
      identity: { ...identity, createdAt },
      task: set(
        ensureMorningBriefDefaultEnabled$,
        {
          orgId: identity.orgId,
          member: {
            userId: identity.userId,
            role: identity.role ?? "member",
          },
        },
        signal,
      ),
    });
  },
);

const postClerkWebhook$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const event = await verifiedClerkWebhook(get(request$).raw);
    signal.throwIfAborted();
    if (!event) {
      return jsonError("Invalid webhook signature", 401);
    }
    L.debug("clerk webhook received", { type: event.type });

    if (event.type === "organization.created") {
      return await set(handleOrganizationCreatedWebhook$, event.data, signal);
    }

    if (event.type === "organizationInvitation.accepted") {
      return handleOrganizationInvitationAcceptedWebhook(
        event.data,
        set(writeDb$),
        signal,
      );
    }

    if (event.type === "organizationMembership.created") {
      return handleOrganizationMembershipCreatedWebhook(
        event.data,
        set(writeDb$),
        signal,
        {
          bootstrap: (identity) => {
            enqueueOrgBootstrap({
              eventType: "organizationMembership.created",
              orgId: identity.orgId,
              userId: identity.userId,
              task: set(
                bootstrapOrgAndDeliverWelcome$,
                {
                  eventType: "organizationMembership.created",
                  orgId: identity.orgId,
                  userId: identity.userId,
                },
                signal,
              ),
            });
          },
          provisionMorningBrief: async (identity) => {
            await set(enrollMorningBriefMembership$, identity, signal);
          },
          deliverWelcomeThread: (identity) => {
            enqueueWelcomeThreadDelivery({
              trigger: "organizationMembership.created",
              orgId: identity.orgId,
              userId: identity.userId,
              task: set(
                deliverWelcomeChatThread$,
                { orgId: identity.orgId, userId: identity.userId },
                signal,
              ),
            });
          },
        },
      );
    }

    if (event.type === "organization.deleted") {
      const orgId = eventDataId(event.data);
      if (!orgId) {
        return missingOrganizationDeletedIdResponse(event.data);
      }
      return await set(handleOrganizationDeletedWebhook$, orgId, signal);
    }

    if (event.type === "user.deleted") {
      const userId = eventDataId(event.data);
      if (!userId) {
        L.error("user.deleted event missing user ID", { data: event.data });
        return new Response("OK", { status: 200 });
      }

      waitUntil(
        tapError(set(cleanupClerkDeletedUser$, userId, signal), (error) => {
          L.error("user.deleted cleanup failed", { userId, error });
          if (isLockNotAvailable(error)) {
            throw error;
          }
        }),
      );
      return new Response("OK", { status: 200 });
    }

    if (event.type === "user.banned") {
      const data = propertyOf(event, "data");
      const userId = eventDataId(data);
      if (!userId) {
        L.error("user.banned event missing user ID", { data });
        return new Response("OK", { status: 200 });
      }

      waitUntil(
        tapError(set(cleanupClerkBannedUser$, userId, signal), (error) => {
          L.error("user.banned cleanup failed", { userId, error });
        }),
      );
      return new Response("OK", { status: 200 });
    }

    if (event.type === "organizationMembership.deleted") {
      const identity = organizationMembershipIdentity(event.data);
      if (!identity) {
        L.error("organizationMembership.deleted event missing org/user ID", {
          data: event.data,
        });
        return new Response("OK", { status: 200 });
      }

      waitUntil(
        tapError(
          set(cleanupClerkDeletedOrgMembership$, identity, signal),
          (error) => {
            L.error("organizationMembership.deleted cleanup failed", {
              ...identity,
              error,
            });
          },
        ),
      );
      return new Response("OK", { status: 200 });
    }

    L.debug("ignoring unhandled Clerk event", { type: event.type });
    return new Response("OK", { status: 200 });
  },
);

export const webhooksClerkRoutes: readonly RouteEntry[] = [
  {
    route: webhookClerkContract.post,
    handler: postClerkWebhook$,
  },
];
