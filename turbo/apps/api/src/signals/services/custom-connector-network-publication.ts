import { command } from "ccstate";
import {
  and,
  eq,
  exists,
  gte,
  lt,
  notExists,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorCloudflareBindings } from "@okouai/db/schema/org-custom-connector-cloudflare-binding";
import type { CustomConnectorNetworkSnapshot } from "./custom-connector-network-authority.service";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import type { CustomConnectorResponse } from "@okouai/api-contracts/contracts/custom-connectors";
import { badRequestMessage } from "../../lib/error";
import { db$ } from "../external/db";
import { userFeatureSwitchContext } from "./feature-switches.service";

/** Reuses the publishing owner's definition fence; never acquires another lock. */
export function customConnectorNetworkPublicationCondition(args: {
  readonly definitionUpdatedAt: Date;
  readonly networkSnapshot?: CustomConnectorNetworkSnapshot;
}) {
  const query = new QueryBuilder();
  const binding = query
    .select({ id: orgCustomConnectorCloudflareBindings.connectorId })
    .from(orgCustomConnectorCloudflareBindings)
    .innerJoin(
      cloudflareAccessConfigs,
      and(
        eq(
          cloudflareAccessConfigs.id,
          orgCustomConnectorCloudflareBindings.configId,
        ),
        eq(
          cloudflareAccessConfigs.orgId,
          orgCustomConnectorCloudflareBindings.orgId,
        ),
        eq(cloudflareAccessConfigs.scope, "organization"),
      ),
    )
    .where(
      and(
        eq(
          orgCustomConnectorCloudflareBindings.connectorId,
          orgCustomConnectors.id,
        ),
        eq(
          orgCustomConnectorCloudflareBindings.orgId,
          orgCustomConnectors.orgId,
        ),
        args.networkSnapshot
          ? and(
              eq(
                orgCustomConnectorCloudflareBindings.configId,
                args.networkSnapshot.configId,
              ),
              eq(
                cloudflareAccessConfigs.generation,
                args.networkSnapshot.generation,
              ),
            )
          : undefined,
      ),
    );
  return and(
    eq(orgCustomConnectors.enabled, true),
    gte(orgCustomConnectors.updatedAt, args.definitionUpdatedAt),
    lt(
      orgCustomConnectors.updatedAt,
      new Date(args.definitionUpdatedAt.getTime() + 1),
    ),
    args.networkSnapshot ? exists(binding) : notExists(binding),
  );
}

export type PreparedCustomConnectorNetworkBinding =
  | { readonly kind: "preserve" }
  | { readonly kind: "clear" }
  | {
      readonly kind: "bind";
      readonly configId: string;
      readonly metadata: NonNullable<CustomConnectorResponse["networkBinding"]>;
    };

/** Publishes the edge in the same statement as its owning definition update. */
export function customConnectorNetworkBindingUpdateCte(args: {
  readonly orgId: string;
  readonly connectorId: string;
  readonly change: PreparedCustomConnectorNetworkBinding | undefined;
  readonly updatedConnector: SQLWrapper;
  readonly updatedConnectorId: SQLWrapper;
}) {
  const query = new QueryBuilder();
  if (args.change?.kind === "bind") {
    return query.$with("updated_connector_network_binding", {}).as(sql`
      insert into ${orgCustomConnectorCloudflareBindings}
        (connector_id, org_id, config_id, config_scope)
      select ${args.updatedConnectorId}, ${args.orgId}, ${args.change.configId}, 'organization'
      from ${args.updatedConnector}
      on conflict (connector_id) do update set config_id = excluded.config_id
      returning connector_id
    `);
  }
  if (args.change?.kind === "clear") {
    return query.$with("removed_connector_network_binding", {}).as(sql`
      delete from ${orgCustomConnectorCloudflareBindings}
      where connector_id = ${args.connectorId} and org_id = ${args.orgId}
        and exists (select 1 from ${args.updatedConnector})
      returning connector_id
    `);
  }
  return undefined;
}

export const prepareCustomConnectorNetworkBinding$ = command(
  async (
    { get },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly requested:
        | { readonly type: "cloudflare_access"; readonly configId: string }
        | null
        | undefined;
      readonly current?: CustomConnectorResponse["networkBinding"];
      readonly headers: readonly { readonly name: string }[];
      readonly targets: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<
    PreparedCustomConnectorNetworkBinding | ReturnType<typeof badRequestMessage>
  > => {
    if (args.requested !== null && (args.requested || args.current)) {
      if (
        args.targets.some((target) => {
          return !target.startsWith("https://");
        })
      ) {
        return badRequestMessage(
          "Cloudflare Access requires HTTPS for every connector firewall prefix",
        );
      }
      if (
        args.headers.some(({ name }) => {
          const key = name.toLowerCase();
          return (
            key === "cf-access-client-id" || key === "cf-access-client-secret"
          );
        })
      ) {
        return badRequestMessage(
          "Cloudflare Access owns its two service-token headers; remove conflicting application header injections",
        );
      }
    }
    if (args.requested === undefined) {
      return { kind: "preserve" };
    }
    if (args.requested === null) {
      return { kind: "clear" };
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
      return badRequestMessage(
        "Custom connector Cloudflare Access is not enabled",
      );
    }
    const [config] = await get(db$)
      .select({
        id: cloudflareAccessConfigs.id,
        name: cloudflareAccessConfigs.name,
        generation: cloudflareAccessConfigs.generation,
      })
      .from(cloudflareAccessConfigs)
      .where(
        and(
          eq(cloudflareAccessConfigs.id, args.requested.configId),
          eq(cloudflareAccessConfigs.orgId, args.orgId),
          eq(cloudflareAccessConfigs.scope, "organization"),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!config) {
      return badRequestMessage(
        "Cloudflare Access must be an available organization configuration from this organization",
      );
    }
    return {
      kind: "bind",
      configId: config.id,
      metadata: {
        type: "cloudflare_access",
        configId: config.id,
        status: "available",
        name: config.name,
        generation: config.generation,
      },
    };
  },
);

export function publishedCustomConnectorNetworkBinding(
  change: PreparedCustomConnectorNetworkBinding | undefined,
  previous: CustomConnectorResponse["networkBinding"] | null | undefined,
) {
  return change?.kind === "bind"
    ? change.metadata
    : change?.kind === "clear"
      ? undefined
      : previous;
}
