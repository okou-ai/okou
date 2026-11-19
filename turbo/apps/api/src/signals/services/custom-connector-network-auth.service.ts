import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { CustomConnectorNetworkIntent } from "@okouai/api-contracts/validators/custom-connector-network";
import type { ConnectorRuntimeSyncResult } from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";

import { matchFirewallRequestDecision } from "@okouai/connectors/firewall-rule-matcher";
import { badRequestMessage, resourceUnavailable } from "../../lib/error";
import type { FirewallAuth } from "../../types/auth";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";

import { resolveConnectorRuntimeTargets$ } from "./connector-runtime-sync.service";
import { resolveCustomConnectorNetworkAdmission$ } from "./custom-connector-network-authority.service";
import { CustomConnectorNetworkError } from "./custom-connector-network-error";

interface NetworkRunAuthority {
  readonly agentId: string | null;
  readonly status: string;
  readonly definitionUpdatedAt: Date;
}

interface NetworkRequest {
  readonly method: string;
  readonly url: string;
  readonly intent: CustomConnectorNetworkIntent;
}

interface NetworkMatch {
  readonly name: string;
  readonly apiId: string;
  readonly customConnectorId: string;
  readonly sourceId?: string;
  readonly routingVariables: Record<string, string>;
}

type AvailableCustomRuntime = Extract<
  ConnectorRuntimeSyncResult,
  {
    readonly state: "available";
    readonly target: { readonly kind: "custom" };
  }
>;

function validateNetworkRequestScope(args: {
  readonly request: NetworkRequest;
  readonly matched: NetworkMatch;
  readonly firewall: AvailableCustomRuntime["firewall"]["firewall"];
  readonly policy: AvailableCustomRuntime["networkPolicy"];
}) {
  const { firewall, request, matched } = args;
  const api = firewall.apis.find((candidate) => {
    return candidate.id === matched.apiId;
  });
  // Observed config generations invalidate cached network credentials. A fresh
  // lookup may advance that generation when a rotation notification was missed.
  if (
    !api ||
    firewall.name !== matched.name ||
    api.networkIntent === undefined ||
    api.networkIntent.kind !== request.intent.kind ||
    (api.networkIntent.kind === "cloudflare_access" &&
      (request.intent.kind !== "cloudflare_access" ||
        api.networkIntent.configId !== request.intent.configId))
  ) {
    return {
      error: resourceUnavailable(
        "Custom connector network intent changed; synchronize before retrying",
      ),
    };
  }
  const decision = matchFirewallRequestDecision(
    [firewall],
    request.method,
    request.url,
    { [firewall.name]: args.policy },
  );
  if (decision.kind !== "allow" || decision.base !== api.base) {
    return {
      error: resourceUnavailable(
        "The request does not match the current custom connector firewall permission",
      ),
    };
  }
  if (
    api.networkIntent.kind === "cloudflare_access" &&
    (new URL(request.url).protocol !== "https:" ||
      ["CONNECT", "TRACE"].includes(request.method.toUpperCase()))
  ) {
    return {
      error: badRequestMessage(
        "Cloudflare Access requires HTTPS and a method that can carry managed credentials",
      ),
    };
  }
  return { intent: api.networkIntent };
}

function activeNetworkRun(
  run: NetworkRunAuthority | undefined,
): run is NetworkRunAuthority & { readonly agentId: string } {
  return (
    run !== undefined &&
    run.agentId !== null &&
    (run.status === "running" || run.status === "pending")
  );
}

function networkAdmissionRunReadQuery(args: {
  readonly auth: FirewallAuth;
  readonly matched: { readonly customConnectorId: string };
}) {
  return new QueryBuilder()
    .select({
      agentId: agentRuns.agentId,
      status: agentRuns.status,
      definitionUpdatedAt: orgCustomConnectors.updatedAt,
    })
    .from(agentRuns)
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(orgCustomConnectors.id, args.matched.customConnectorId),
        eq(orgCustomConnectors.orgId, agentRuns.orgId),
        eq(orgCustomConnectors.enabled, true),
      ),
    )
    .where(
      and(
        eq(agentRuns.id, args.auth.runId),
        eq(agentRuns.orgId, args.auth.orgId),
        eq(agentRuns.userId, args.auth.userId),
      ),
    )
    .limit(1);
}

export const admitCustomConnectorNetworkRequest$ = command(
  async (
    { set },
    args: {
      readonly auth: FirewallAuth;
      readonly request: NetworkRequest;
      readonly matched: NetworkMatch;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const ownedRun =
      networkAdmissionRunReadQuery(args).as("custom_network_run");
    const [run] = await db.select().from(ownedRun);
    signal.throwIfAborted();

    if (!activeNetworkRun(run)) {
      return resourceUnavailable(
        "Run cannot admit custom connector network credentials",
      );
    }
    const [runtime] = await set(resolveConnectorRuntimeTargets$, {
      scope: {
        orgId: args.auth.orgId,
        userId: args.auth.userId,
        agentId: run.agentId,
        runId: args.auth.runId,
      },
      targets: [
        {
          kind: "custom",
          customConnectorId: args.matched.customConnectorId,
          baseUrlVars: args.matched.routingVariables,
          ...(args.matched.sourceId ? { sourceId: args.matched.sourceId } : {}),
        },
      ],
    });
    signal.throwIfAborted();
    if (
      !runtime ||
      runtime.state !== "available" ||
      runtime.target.kind !== "custom" ||
      !("baseUrlVars" in runtime)
    ) {
      return resourceUnavailable(
        "Custom connector is unavailable for this Run",
      );
    }
    const scope = validateNetworkRequestScope({
      request: args.request,
      matched: args.matched,
      firewall: runtime.firewall.firewall,
      policy: runtime.networkPolicy,
    });
    if (scope.error) {
      return scope.error;
    }
    const admission = await settle(
      set(
        resolveCustomConnectorNetworkAdmission$,
        {
          orgId: args.auth.orgId,
          userId: args.auth.userId,
          connectorId: args.matched.customConnectorId,
          expected: scope.intent,
          definitionUpdatedAt: run.definitionUpdatedAt,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!admission.ok) {
      if (!(admission.error instanceof CustomConnectorNetworkError)) {
        throw admission.error;
      }
      return resourceUnavailable(admission.error.message);
    }
    const networkAdmission = admission.value;
    const [current] = await db.select().from(ownedRun);
    signal.throwIfAborted();
    if (
      !activeNetworkRun(current) ||
      current.agentId !== run.agentId ||
      current.definitionUpdatedAt.getTime() !==
        run.definitionUpdatedAt.getTime()
    ) {
      return resourceUnavailable("Run is no longer active");
    }
    return {
      status: 200 as const,
      body: {
        headers: {},
        expiresAt: null,
        resolvedSecrets: [],
        refreshedConnectors: [],
        refreshedSecrets: [],
        networkAdmission,
      },
    };
  },
);
