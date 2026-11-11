import { command } from "ccstate";
import { and, eq } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { CustomConnectorNetworkIntent } from "@okouai/api-contracts/validators/custom-connector-network";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { matchFirewallRequestDecision } from "@okouai/connectors/firewall-rule-matcher";
import { badRequestMessage, resourceUnavailable } from "../../lib/error";
import type { SandboxAuth } from "../../types/auth";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { resolveConnectorRuntimeTargets$ } from "./connector-runtime-sync.service";
import {
  CustomConnectorNetworkError,
  resolveCustomConnectorNetworkAdmission$,
} from "./custom-connector-network-authority.service";

interface NetworkRunAuthority {
  readonly agentId: string | null;
  readonly status: string;
  readonly definitionUpdatedAt: Date;
  readonly grantId: string | null;
}

function activeNetworkRun(
  run: NetworkRunAuthority | undefined,
  chatAccounts: boolean,
): run is NetworkRunAuthority & { readonly agentId: string } {
  return (
    run !== undefined &&
    run.agentId !== null &&
    (chatAccounts || run.grantId !== null) &&
    (run.status === "running" || run.status === "pending")
  );
}

function networkAdmissionRunReadQuery(args: {
  readonly auth: SandboxAuth;
  readonly matched: { readonly customConnectorId: string };
}) {
  return new QueryBuilder()
    .select({
      agentId: agentRuns.agentId,
      status: agentRuns.status,
      definitionUpdatedAt: orgCustomConnectors.updatedAt,
      grantId: userCustomConnectors.id,
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
    .leftJoin(
      userCustomConnectors,
      and(
        eq(userCustomConnectors.customConnectorId, orgCustomConnectors.id),
        eq(userCustomConnectors.orgId, agentRuns.orgId),
        eq(userCustomConnectors.userId, agentRuns.userId),
        eq(userCustomConnectors.agentId, agentRuns.agentId),
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
    { get, set },
    args: {
      readonly auth: SandboxAuth;
      readonly request: {
        readonly method: string;
        readonly url: string;
        readonly intent: CustomConnectorNetworkIntent;
      };
      readonly matched: {
        readonly name: string;
        readonly apiId: string;
        readonly customConnectorId: string;
        readonly sourceId?: string;
        readonly routingVariables: Record<string, string>;
      };
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const ownedRun =
      networkAdmissionRunReadQuery(args).as("custom_network_run");
    const [run] = await db.select().from(ownedRun);
    signal.throwIfAborted();
    const features = await get(
      userFeatureSwitchContext(args.auth.orgId, args.auth.userId),
    );
    signal.throwIfAborted();
    const chatAccounts = isFeatureEnabled(
      FeatureSwitchKey.ConnectorChatAccountAccess,
      features,
    );
    if (!activeNetworkRun(run, chatAccounts)) {
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
    const firewall = runtime.firewall.firewall;
    const api = firewall.apis.find((a) => {
      return a.id === args.matched.apiId;
    });
    if (
      !api ||
      firewall.name !== args.matched.name ||
      api.networkIntent === undefined ||
      JSON.stringify(api.networkIntent) !== JSON.stringify(args.request.intent)
    ) {
      return resourceUnavailable(
        "Custom connector network intent changed; synchronize before retrying",
      );
    }
    const decision = matchFirewallRequestDecision(
      [firewall],
      args.request.method,
      args.request.url,
      { [firewall.name]: runtime.networkPolicy },
    );
    if (decision.kind !== "allow" || decision.base !== api.base) {
      return resourceUnavailable(
        "The request does not match the current custom connector firewall permission",
      );
    }
    if (
      api.networkIntent.kind === "cloudflare_access" &&
      (new URL(args.request.url).protocol !== "https:" ||
        ["CONNECT", "TRACE"].includes(args.request.method.toUpperCase()))
    ) {
      return badRequestMessage(
        "Cloudflare Access requires HTTPS and a method that can carry managed credentials",
      );
    }
    const admission = await settle(
      set(
        resolveCustomConnectorNetworkAdmission$,
        {
          orgId: args.auth.orgId,
          userId: args.auth.userId,
          connectorId: args.matched.customConnectorId,
          expected: api.networkIntent,
          definitionUpdatedAt: run.definitionUpdatedAt,
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (!admission.ok) {
      if (!(admission.error instanceof CustomConnectorNetworkError))
        throw admission.error;
      return resourceUnavailable(admission.error.message);
    }
    const networkAdmission = admission.value;
    const [current] = await db.select().from(ownedRun);
    signal.throwIfAborted();
    if (
      !activeNetworkRun(current, chatAccounts) ||
      current.agentId !== run.agentId ||
      current.definitionUpdatedAt.getTime() !==
        run.definitionUpdatedAt.getTime()
    )
      return resourceUnavailable("Run is no longer active");
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
