import { command, computed } from "ccstate";
import { featureGuidesContract } from "@okouai/api-contracts/contracts/feature-guides";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { isStaffOrg } from "@okouai/core/staff-org";
import { optionalEnv } from "../../lib/env";
import { resourceUnavailable, notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { createUserFeatureSwitchContext } from "../services/feature-switches.service";
import {
  acknowledgeableFeatureGuideRevision,
  currentFeatureGuide$,
  featureGuideReceipt,
  featureGuideRevision,
  importFeatureGuide$,
  markFeatureGuideSeen$,
  publishFeatureGuide$,
} from "../services/feature-guides.service";

const switchContext$ = createUserFeatureSwitchContext(
  computed((get) => {
    return Promise.resolve(get(organizationAuthContext$));
  }),
);
const enabled$ = computed(async (get) => {
  return isFeatureEnabled(
    FeatureSwitchKey.FeatureGuides,
    await get(switchContext$),
  );
});
const receipt$ = featureGuideReceipt(
  computed(async (get) => {
    const { userId } = get(organizationAuthContext$);
    const edition = await get(currentFeatureGuide$);
    return edition ? { userId, editionId: edition.id } : null;
  }),
);
const currentQuery$ = queryOf(featureGuidesContract.current);
const current$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const enabled = await get(enabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return { status: 200 as const, body: { edition: null } };
  }
  const preview = get(currentQuery$)?.preview === "1";
  if (preview && optionalEnv("ENV") !== "preview") {
    return resourceUnavailable(
      "Guide previews are available only in preview deployments",
    );
  }
  const edition = await get(currentFeatureGuide$);
  signal.throwIfAborted();
  if (!edition) {
    return { status: 200 as const, body: { edition: null } };
  }
  if (preview) {
    return { status: 200 as const, body: { edition, preview: true } };
  }
  const receipt = await get(receipt$);
  signal.throwIfAborted();
  return { status: 200 as const, body: { edition: receipt ? null : edition } };
});
const seenBody$ = bodyResultOf(featureGuidesContract.seen);
const seenParams$ = pathParamsOf(featureGuidesContract.seen);
const seenRevision$ = acknowledgeableFeatureGuideRevision(
  computed(async (get) => {
    const body = await get(seenBody$);
    return body.ok
      ? { ...get(seenParams$), revisionId: body.data.revisionId }
      : null;
  }),
);
const seen$ = command(async ({ get, set }, signal: AbortSignal) => {
  const enabled = await get(enabled$);
  signal.throwIfAborted();
  if (!enabled) {
    return resourceUnavailable("Feature guides are not enabled");
  }
  const body = await get(seenBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { editionId } = get(seenParams$);
  // A visible edition can be acknowledged even when another edition or a
  // corrected revision was published while the user was reading it.
  const revision = await get(seenRevision$);
  signal.throwIfAborted();
  if (!revision) {
    return notFound("Published feature guide not found");
  }
  await set(
    markFeatureGuideSeen$,
    get(organizationAuthContext$).userId,
    editionId,
    body.data.revisionId,
    signal,
  );
  return { status: 200 as const, body: { seen: true as const } };
});
const importBody$ = bodyResultOf(featureGuidesContract.import);
const import$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { orgId, userId } = get(organizationAuthContext$);
  if (!isStaffOrg(orgId)) {
    return resourceUnavailable("Only staff can prepare feature guides");
  }
  const body = await get(importBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  return {
    status: 200 as const,
    body: await set(importFeatureGuide$, body.data, userId, signal),
  };
});
const publishBody$ = bodyResultOf(featureGuidesContract.publish);
const publishParams$ = pathParamsOf(featureGuidesContract.publish);
const publishRevision$ = featureGuideRevision(
  computed(async (get) => {
    const body = await get(publishBody$);
    return body.ok && body.data.revisionId
      ? { ...get(publishParams$), revisionId: body.data.revisionId }
      : null;
  }),
);
const publish$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { orgId, userId } = get(organizationAuthContext$);
  if (!isStaffOrg(orgId)) {
    return resourceUnavailable("Only staff can publish feature guides");
  }
  const body = await get(publishBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const { editionId } = get(publishParams$);
  if (body.data.revisionId) {
    const revision = await get(publishRevision$);
    signal.throwIfAborted();
    if (!revision) {
      return notFound("Feature guide revision not found");
    }
  }
  const updated = await set(
    publishFeatureGuide$,
    editionId,
    body.data.revisionId,
    userId,
    signal,
  );
  return updated
    ? {
        status: 200 as const,
        body: { published: body.data.revisionId !== null },
      }
    : notFound("Feature guide edition not found");
});
const auth = {
  accept: ["session"],
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;
export const featureGuidesRoutes: readonly RouteEntry[] = [
  { route: featureGuidesContract.current, handler: authRoute(auth, current$) },
  { route: featureGuidesContract.seen, handler: authRoute(auth, seen$) },
  { route: featureGuidesContract.import, handler: authRoute(auth, import$) },
  { route: featureGuidesContract.publish, handler: authRoute(auth, publish$) },
];
