import { command } from "ccstate";
import { integrationsEmailContract as contract } from "@okouai/api-contracts/contracts/integrations-email";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { conflict, resourceUnavailable } from "../../lib/error";
import { now } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { clerk$ } from "../external/clerk";
import { listAllUserOrganizationMemberships } from "../external/clerk-organization-lists";
import { emailRunSource$ } from "../services/email-run-source.service";
import { changeEmailSession$ } from "../services/email-session.service";
import { drainEmailOutboxBatch$ } from "../services/email-common.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const session$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    return resourceUnavailable(
      "Email binding commands require an Email-originated run.",
    );
  }
  const source = await set(emailRunSource$, auth, signal);
  if (!source) {
    return resourceUnavailable(
      "This run has no active, verified Email binding. Continue in the current email conversation.",
    );
  }
  const features = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  if (
    !isFeatureEnabled(FeatureSwitchKey.EmailIntegration, {
      ...features,
      email: source.emailAddress,
    })
  ) {
    return resourceUnavailable("Email integration is not available");
  }
  const memberships = await listAllUserOrganizationMemberships(
    get(clerk$).users,
    auth.userId,
    undefined,
    signal,
  );
  const workspaces = memberships.map(({ organization }) => {
    return { id: organization.id, name: organization.name };
  });
  const workspace = workspaces.find(({ id }) => {
    return id === auth.orgId;
  });
  if (!workspace) {
    return resourceUnavailable(
      "This Email workspace is no longer available to your account.",
    );
  }
  return { auth, source, workspace, workspaces };
});

const getBinding$ = command(async ({ set }, signal: AbortSignal) => {
  const session = await set(session$, signal);
  if ("status" in session) {
    return session;
  }
  return {
    status: 200 as const,
    body: {
      emailAddress: session.source.emailAddress,
      workspace: session.workspace,
      workspaces: session.workspaces,
    },
  };
});

const switchBody$ = bodyResultOf(contract.switchWorkspace);
const switchWorkspace$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(switchBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const session = await set(session$, signal);
  if ("status" in session) {
    return session;
  }
  const workspace = session.workspaces.find(({ id }) => {
    return id === body.data.workspaceId;
  });
  if (!workspace) {
    return resourceUnavailable(
      "Choose a workspace you belong to from okou email status.",
    );
  }
  if (workspace.id === session.workspace.id) {
    return conflict("This email is already connected to that workspace.");
  }
  const features = await set(
    loadUserFeatureSwitchContext$,
    workspace.id,
    session.auth.userId,
    signal,
  );
  if (
    !isFeatureEnabled(FeatureSwitchKey.EmailIntegration, {
      ...features,
      email: session.source.emailAddress,
    })
  ) {
    return resourceUnavailable(
      "Email integration is not available in that workspace.",
    );
  }
  const changed = await set(
    changeEmailSession$,
    { ...session.auth, source: session.source, workspace },
    signal,
  );
  if (!changed) {
    return conflict(
      "The Email binding changed. Continue in a new email conversation.",
    );
  }
  waitUntil(set(drainEmailOutboxBatch$, { currentTimeMs: now() }, signal));
  return {
    status: 200 as const,
    body: { emailAddress: session.source.emailAddress, workspace },
  };
});

const logout$ = command(async ({ set }, signal: AbortSignal) => {
  const session = await set(session$, signal);
  if ("status" in session) {
    return session;
  }
  const changed = await set(
    changeEmailSession$,
    { ...session.auth, source: session.source },
    signal,
  );
  if (!changed) {
    return conflict(
      "The Email binding changed. Continue in a new email conversation.",
    );
  }
  waitUntil(set(drainEmailOutboxBatch$, { currentTimeMs: now() }, signal));
  return {
    status: 200 as const,
    body: { emailAddress: session.source.emailAddress },
  };
});

const auth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "email:write",
} as const;

export const integrationsEmailSessionRoutes: readonly RouteEntry[] = [
  { route: contract.getBinding, handler: authRoute(auth, getBinding$) },
  {
    route: contract.switchWorkspace,
    handler: authRoute(auth, switchWorkspace$),
  },
  { route: contract.logout, handler: authRoute(auth, logout$) },
];
