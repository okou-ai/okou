import { command } from "ccstate";
import { int, iso, object, uuid } from "zod";
import { and, eq, gte, lt } from "drizzle-orm";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { cloudflareAccessCredentialsSchema } from "@okouai/api-contracts/validators/cloudflare-access-credentials";
import type {
  CustomConnectorNetworkAdmission,
  CustomConnectorNetworkIntent,
} from "@okouai/api-contracts/validators/custom-connector-network";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorCloudflareBindings } from "@okouai/db/schema/org-custom-connector-cloudflare-binding";
import { writeDb$ } from "../external/db";
import { decryptStoredSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { matchFirewallRequestDecision } from "@okouai/connectors/firewall-rule-matcher";
import {
  createMcpOAuthSafeFetch,
  mcpOAuthSafeFetch,
} from "./mcp-oauth-safe-fetch.service";
import { parseCustomMcpEndpoint } from "./custom-mcp-endpoint";
import {
  renderCustomConnectorRuntimePrefix,
  type CustomConnectorRow,
} from "./custom-connector.service";

export class CustomConnectorNetworkError extends Error {
  constructor(
    readonly reason: "changed" | "unavailable" | "scope" | "rejected",
  ) {
    super(
      reason === "changed"
        ? "Custom connector network authority changed; check the connector and retry explicitly"
        : reason === "scope"
          ? "The request is outside the custom connector's allowed network scope"
          : reason === "rejected"
            ? "Cloudflare Access rejected the request; check its service token and application policy"
            : "Custom connector network authentication is unavailable",
    );
    this.name = "CustomConnectorNetworkError";
  }
}

export interface CustomConnectorNetworkIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
}

/** Nonsecret, server-owned OAuth setup authority. Never contains the service token. */
export interface CustomConnectorNetworkSnapshot {
  readonly configId: string;
  readonly generation: number;
  readonly definitionUpdatedAt: string;
}

export const customConnectorNetworkSnapshotSchema = object({
  configId: uuid(),
  generation: int().positive().max(2147483647),
  definitionUpdatedAt: iso.datetime(),
}).strict();

export const prepareCustomConnectorNetworkFetch$ = command(
  async (
    { get, set },
    args: {
      readonly connector: CustomConnectorRow;
      readonly userId: string;
      /** null is a legacy/unbound setup; undefined starts a new setup. */
      readonly setupSnapshot?: CustomConnectorNetworkSnapshot | null;
    },
    signal: AbortSignal,
  ) => {
    const { connector } = args;
    const feature = await get(
      userFeatureSwitchContext(connector.orgId, args.userId),
    );
    signal.throwIfAborted();
    const enabled = isFeatureEnabled(
      FeatureSwitchKey.CustomConnectorCloudflareAccess,
      feature,
    );
    const binding = connector.networkBinding;
    if (binding && (!enabled || binding.status !== "available"))
      throw new CustomConnectorNetworkError("unavailable");
    if (args.setupSnapshot === null && binding)
      throw new CustomConnectorNetworkError("changed");
    if (
      args.setupSnapshot &&
      (!binding ||
        binding.configId !== args.setupSnapshot.configId ||
        connector.updatedAt.toISOString() !==
          args.setupSnapshot.definitionUpdatedAt)
    )
      throw new CustomConnectorNetworkError("changed");
    if (!enabled && !binding)
      return { fetch: mcpOAuthSafeFetch, snapshot: undefined };
    const [config] = binding
      ? await set(writeDb$)
          .select({ generation: cloudflareAccessConfigs.generation })
          .from(cloudflareAccessConfigs)
          .where(
            and(
              eq(cloudflareAccessConfigs.id, binding.configId),
              eq(cloudflareAccessConfigs.orgId, connector.orgId),
              eq(cloudflareAccessConfigs.scope, "organization"),
            ),
          )
          .limit(1)
      : [];
    signal.throwIfAborted();
    if (binding && !config)
      throw new CustomConnectorNetworkError("unavailable");
    if (
      args.setupSnapshot &&
      config?.generation !== args.setupSnapshot.generation
    )
      throw new CustomConnectorNetworkError("changed");
    const snapshot =
      binding && config
        ? {
            configId: binding.configId,
            generation: config.generation,
            definitionUpdatedAt: connector.updatedAt.toISOString(),
          }
        : undefined;
    const intent: CustomConnectorNetworkIntent = binding
      ? { kind: "cloudflare_access", configId: binding.configId }
      : { kind: "direct" };
    const mcp =
      connector.kind === "mcp"
        ? parseCustomMcpEndpoint(connector.endpoint)
        : undefined;
    if (mcp && "error" in mcp) throw new CustomConnectorNetworkError("scope");
    const bases =
      connector.kind === "http"
        ? connector.prefixTemplates.flatMap((template) => {
            const base = renderCustomConnectorRuntimePrefix({
              template,
              values: {},
            });
            return base ? [base] : [];
          })
        : mcp && "ok" in mcp
          ? [mcp.ok.firewallBase]
          : [];
    const firewall = {
      name: `custom:${connector.id}`,
      apis: bases.map((base, index) => {
        return {
          id: String(index),
          base,
          auth: {},
        };
      }),
    };
    return {
      snapshot,
      fetch: createMcpOAuthSafeFetch(async ({ url, method }, requestSignal) => {
        const admission = await set(
          resolveCustomConnectorNetworkAdmission$,
          {
            orgId: connector.orgId,
            userId: args.userId,
            connectorId: connector.id,
            expected: intent,
            definitionUpdatedAt: connector.updatedAt,
            ...(snapshot ? { generation: snapshot.generation } : {}),
          },
          requestSignal,
        );
        const match = matchFirewallRequestDecision(
          [firewall],
          method,
          url.href,
        );
        return match.kind === "allow" && admission.kind === "cloudflare_access"
          ? admission.headers
          : {};
      }),
    };
  },
);

/** Current storage is the network credential owner, never an application cache. */
export const resolveCustomConnectorNetworkAdmission$ = command(
  async (
    { get, set },
    args: CustomConnectorNetworkIdentity & {
      readonly expected: CustomConnectorNetworkIntent;
      readonly definitionUpdatedAt?: Date;
      readonly generation?: number;
    },
    signal: AbortSignal,
  ): Promise<CustomConnectorNetworkAdmission> => {
    const [row] = await set(writeDb$)
      .select({
        connectorId: orgCustomConnectors.id,
        definitionUpdatedAt: orgCustomConnectors.updatedAt,
        configId: orgCustomConnectorCloudflareBindings.configId,
        availableConfigId: cloudflareAccessConfigs.id,
        generation: cloudflareAccessConfigs.generation,
        clientId: cloudflareAccessConfigs.encryptedClientId,
        clientSecret: cloudflareAccessConfigs.encryptedClientSecret,
      })
      .from(orgCustomConnectors)
      .leftJoin(
        orgCustomConnectorCloudflareBindings,
        and(
          eq(
            orgCustomConnectorCloudflareBindings.connectorId,
            orgCustomConnectors.id,
          ),
          eq(
            orgCustomConnectorCloudflareBindings.orgId,
            orgCustomConnectors.orgId,
          ),
        ),
      )
      .leftJoin(
        cloudflareAccessConfigs,
        and(
          eq(
            cloudflareAccessConfigs.id,
            orgCustomConnectorCloudflareBindings.configId,
          ),
          eq(cloudflareAccessConfigs.orgId, orgCustomConnectors.orgId),
          eq(cloudflareAccessConfigs.scope, "organization"),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.id, args.connectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.enabled, true),
          args.definitionUpdatedAt === undefined
            ? undefined
            : and(
                gte(orgCustomConnectors.updatedAt, args.definitionUpdatedAt),
                lt(
                  orgCustomConnectors.updatedAt,
                  new Date(args.definitionUpdatedAt.getTime() + 1),
                ),
              ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!row) throw new CustomConnectorNetworkError("unavailable");
    if (row.configId === null) {
      if (args.expected.kind !== "direct")
        throw new CustomConnectorNetworkError("changed");
      return { kind: "direct" };
    }
    if (
      args.expected.kind !== "cloudflare_access" ||
      args.expected.configId !== row.configId
    ) {
      throw new CustomConnectorNetworkError("changed");
    }
    if (
      !row.availableConfigId ||
      row.generation === null ||
      !row.clientId ||
      !row.clientSecret
    ) {
      throw new Error(
        "Cloudflare binding violates its persisted configuration invariant",
      );
    }
    if (args.generation !== undefined && args.generation !== row.generation) {
      throw new CustomConnectorNetworkError("changed");
    }
    const feature = await get(
      userFeatureSwitchContext(args.orgId, args.userId),
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.CustomConnectorCloudflareAccess,
        feature,
      )
    ) {
      throw new CustomConnectorNetworkError("unavailable");
    }
    const [clientId, clientSecret] = await Promise.all([
      decryptStoredSecretValue(row.clientId, feature),
      decryptStoredSecretValue(row.clientSecret, feature),
    ]);
    signal.throwIfAborted();
    const credentials = cloudflareAccessCredentialsSchema.parse({
      clientId,
      clientSecret,
    });
    const [current] = await set(writeDb$)
      .select({ id: orgCustomConnectors.id })
      .from(orgCustomConnectors)
      .innerJoin(
        orgCustomConnectorCloudflareBindings,
        and(
          eq(
            orgCustomConnectorCloudflareBindings.connectorId,
            orgCustomConnectors.id,
          ),
          eq(
            orgCustomConnectorCloudflareBindings.orgId,
            orgCustomConnectors.orgId,
          ),
        ),
      )
      .innerJoin(
        cloudflareAccessConfigs,
        and(
          eq(
            cloudflareAccessConfigs.id,
            orgCustomConnectorCloudflareBindings.configId,
          ),
          eq(cloudflareAccessConfigs.orgId, orgCustomConnectors.orgId),
          eq(cloudflareAccessConfigs.scope, "organization"),
        ),
      )
      .where(
        and(
          eq(orgCustomConnectors.id, args.connectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.enabled, true),
          gte(orgCustomConnectors.updatedAt, row.definitionUpdatedAt),
          lt(
            orgCustomConnectors.updatedAt,
            new Date(row.definitionUpdatedAt.getTime() + 1),
          ),
          eq(cloudflareAccessConfigs.id, row.configId),
          eq(cloudflareAccessConfigs.generation, row.generation),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!current) throw new CustomConnectorNetworkError("changed");
    return {
      kind: "cloudflare_access",
      configId: row.configId,
      generation: row.generation,
      headers: {
        "CF-Access-Client-Id": credentials.clientId,
        "CF-Access-Client-Secret": credentials.clientSecret,
      },
    };
  },
);
