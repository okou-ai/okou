import { computed, type Computed } from "ccstate";

import { request$ } from "../context/hono";
import { authenticateClerkSession } from "../external/clerk";
import { ApiOrgRole } from "../../types/auth";

type ClerkSessionAuthContext =
  | {
      readonly tokenType: "session";
      readonly userId: string;
      readonly sessionId?: string;
      readonly orgId: string;
      readonly orgRole: ApiOrgRole;
    }
  | {
      readonly tokenType: "session";
      readonly userId: string;
      readonly sessionId?: string;
      readonly orgId?: undefined;
      readonly orgRole?: undefined;
    };

function mapClerkOrgRole(orgRole: string | null): ApiOrgRole | undefined {
  if (!orgRole) {
    return undefined;
  }

  return orgRole === "org:admin" ? "admin" : "member";
}

const requestState$ = computed((get) => {
  const request = get(request$);
  return authenticateClerkSession(request.raw);
});

export const clerkSessionAuth$: Computed<
  Promise<ClerkSessionAuthContext | null>
> = computed(async (get): Promise<ClerkSessionAuthContext | null> => {
  const identity = await get(requestState$);

  if (!identity) {
    return null;
  }

  const orgRole = mapClerkOrgRole(identity.orgRole);
  const session = identity.sessionId ? { sessionId: identity.sessionId } : {};

  if (identity.orgId && orgRole) {
    return {
      tokenType: "session",
      userId: identity.userId,
      ...session,
      orgId: identity.orgId,
      orgRole,
    };
  }

  return {
    tokenType: "session",
    userId: identity.userId,
    ...session,
  };
});
