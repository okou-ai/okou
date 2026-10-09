import { orgOpenrouterPresetContract } from "@okouai/api-contracts/contracts/org-openrouter-preset";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { command, computed } from "ccstate";
import { eq } from "drizzle-orm";

import { resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchContext } from "../services/feature-switches.service";

const canManagePreset$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return false;
  }
  const context = await get(userFeatureSwitchContext(auth.orgId, auth.userId));
  return isFeatureEnabled(FeatureSwitchKey.OkouDebug, context);
});

const getPreset$ = command(async ({ get }, signal: AbortSignal) => {
  const allowed = await get(canManagePreset$);
  signal.throwIfAborted();
  if (!allowed) {
    return resourceUnavailable(
      "Only organization administrators with Okou Debug can manage presets",
    );
  }
  const { orgId } = get(organizationAuthContext$);
  const [metadata] = await get(db$)
    .select({ openrouterPreset: orgMetadata.openrouterPreset })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { openrouterPreset: metadata?.openrouterPreset ?? null },
  };
});

const updateBody$ = bodyResultOf(orgOpenrouterPresetContract.update);
const updatePreset$ = command(async ({ get, set }, signal: AbortSignal) => {
  const allowed = await get(canManagePreset$);
  signal.throwIfAborted();
  if (!allowed) {
    return resourceUnavailable(
      "Only organization administrators with Okou Debug can manage presets",
    );
  }
  const body = await get(updateBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { orgId } = get(organizationAuthContext$);
  const db = set(writeDb$);
  await db
    .insert(orgMetadataCanonicalWrites)
    .values({ orgId, openrouterPreset: body.data.openrouterPreset })
    .onConflictDoUpdate({
      target: orgMetadataCanonicalWrites.orgId,
      set: { openrouterPreset: body.data.openrouterPreset },
    });
  signal.throwIfAborted();
  return { status: 200 as const, body: body.data };
});

const authOptions = {
  accept: ["session"],
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

export const orgOpenrouterPresetRoutes: readonly RouteEntry[] = [
  {
    route: orgOpenrouterPresetContract.get,
    handler: authRoute(authOptions, getPreset$),
  },
  {
    route: orgOpenrouterPresetContract.update,
    handler: authRoute(authOptions, updatePreset$),
  },
];
