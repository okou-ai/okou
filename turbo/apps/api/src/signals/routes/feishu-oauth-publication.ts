import { randomUUID } from "node:crypto";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { agents } from "@okouai/db/schema/agent";
import { connectors } from "@okouai/db/schema/connector";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgMetadataCanonicalWrites } from "@okouai/db/operations/org-metadata-canonical-write";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { secrets } from "@okouai/db/schema/secret";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { variables } from "@okouai/db/schema/variable";
import {
  and,
  eq,
  exists,
  getTableColumns,
  not,
  or,
  sql,
  SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { boolean, literal, object, string } from "zod";
import { nowDate } from "../../lib/time";
import { zodDriverValueDecoder } from "../../lib/db-structured-result";
import { completedGetStartedQuestPublication } from "../services/get-started-member-reward";
import { CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY } from "../services/get-started-rewards.service";
import { slackRewardWalletEntitlement } from "../services/slack-installation-reward";
import {
  connectionTokenRows,
  type CustomConnectorOAuthTokenResult,
  type encryptTokenValues,
} from "../services/custom-connector-oauth2.service";

interface FeishuOAuthPublicationInput {
  readonly state: {
    readonly installationId: string;
    readonly orgId: string;
    readonly userId: string;
    readonly accountMutation: ConnectorAccountMutationIntent;
  };
  readonly installation: {
    readonly defaultAgentId: string;
    readonly tenantKey: string | null;
  };
  readonly connector: { readonly id: string; readonly storageVersion: number };
  readonly token: CustomConnectorOAuthTokenResult;
  readonly userInfo: {
    readonly openId: string;
    readonly name: string | null;
    readonly tenantKey: string | null;
  };
}

type EncryptedFeishuTokens = Awaited<ReturnType<typeof encryptTokenValues>>;
const members = feishuOrgConnections;
const accounts = connectors;
const definitions = orgCustomConnectors;
const configs = orgCustomConnectorOauthConfigs;
const grants = userCustomConnectors;
type TimedFeishuOAuthPublicationInput = FeishuOAuthPublicationInput & {
  readonly at: Date;
};

export const feishuOAuthPublicationRow = object({
  agent: boolean(),
  credentialContract: boolean(),
  definitionEnabled: boolean(),
  foreignOwner: boolean(),
  member: object({
    connectionId: string(),
    shouldNotify: boolean(),
  }).nullable(),
  complete: literal(1),
});

function feishuOAuthAdmission(args: TimedFeishuOAuthPublicationInput) {
  const query = new QueryBuilder();
  const agent = query.$with("oauth_agent").as(
    query
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, args.installation.defaultAgentId),
          eq(agents.orgId, args.state.orgId),
          or(
            eq(agents.visibility, "public"),
            eq(agents.owner, args.state.userId),
          ),
        ),
      )
      .for("update")
      .limit(1),
  );
  const definition = query.$with("oauth_definition").as(
    query
      .select({
        id: definitions.id,
        authMode: definitions.authMode,
        storageVersion: definitions.storageVersion,
        enabled: definitions.enabled,
        slug: definitions.slug,
        prefixTemplates: definitions.prefixTemplates,
        permissionBundleRef: definitions.permissionBundleRef,
        providerAdapter: configs.providerAdapter,
      })
      .from(definitions)
      .leftJoin(
        configs,
        and(
          eq(configs.connectorId, definitions.id),
          eq(configs.orgId, definitions.orgId),
        ),
      )
      .where(
        and(
          eq(definitions.id, args.connector.id),
          eq(definitions.orgId, args.state.orgId),
          exists(query.select().from(agent)),
        ),
      )
      .for("update", { of: definitions })
      .limit(1),
  );
  const contract = query
    .select()
    .from(definition)
    .where(
      and(
        eq(definition.authMode, "oauth"),
        eq(definition.storageVersion, args.connector.storageVersion),
        eq(definition.providerAdapter, "feishu"),
      ),
    );
  const foreign = exists(
    query
      .select({ id: members.id })
      .from(members)
      .where(
        and(
          eq(members.installationId, args.state.installationId),
          eq(members.feishuOpenId, args.userInfo.openId),
          not(eq(members.userId, args.state.userId)),
        ),
      ),
  );
  const eligible = query
    .select({ id: definition.id })
    .from(definition)
    .where(and(exists(contract), eq(definition.enabled, true), not(foreign)));
  return { agent, definition, contract, foreign, eligible };
}

function feishuOAuthMember(
  args: TimedFeishuOAuthPublicationInput,
  admission: ReturnType<typeof feishuOAuthAdmission>,
  prepared: boolean,
) {
  const query = new QueryBuilder();
  const account = args.state.accountMutation;
  const proposedAccountId =
    account.intent === "reconnect" ? account.connectionId : randomUUID();
  const removed = query.$with("oauth_previous_members", { id: members.id })
    .as(sql`
    DELETE FROM ${members} WHERE ${members.installationId} = ${args.state.installationId}::uuid
      AND ${members.userId} = ${args.state.userId} AND ${members.feishuOpenId} <> ${args.userInfo.openId}
      AND ${prepared} AND EXISTS (${admission.eligible}) RETURNING id
  `);
  // The account FK is checked at the end of this statement. The member's
  // actual RETURNING identity, including a pre-existing link, owns every write.
  const claimed = query.$with("oauth_member", {
    id: members.id,
    connectorId: members.connectorId,
    dmWelcomeSent: members.dmWelcomeSent,
  }).as(sql`
    INSERT INTO ${members} (installation_id, feishu_open_id, user_id, feishu_user_name, connector_id, updated_at)
    SELECT ${args.state.installationId}::uuid, ${args.userInfo.openId}, ${args.state.userId},
      ${args.userInfo.name}, ${proposedAccountId}::uuid, ${sql.param(args.at, members.updatedAt)}
    WHERE ${prepared} AND EXISTS (${admission.eligible})
      AND (SELECT count(*) FROM ${removed}) >= 0
    ON CONFLICT (feishu_open_id, installation_id) DO UPDATE SET
      feishu_user_name = EXCLUDED.feishu_user_name,
      connector_id = coalesce(${members.connectorId}, EXCLUDED.connector_id), updated_at = ${sql.param(args.at, members.updatedAt)}
    WHERE ${members.userId} = EXCLUDED.user_id
    RETURNING id, connector_id, dm_welcome_sent
  `);
  return { proposedAccountId, removed, claimed };
}

function feishuWalletEntitlementSql(orgId: string, source: SQL): SQL {
  const values = slackRewardWalletEntitlement(orgId);
  const schema = Object.entries(getTableColumns(orgPlanEntitlements));
  const cells = Object.entries(values)
    .filter(([, value]) => {
      return value !== undefined;
    })
    .map(([field, value]) => {
      const column = schema.find(([key]) => {
        return key === field;
      })?.[1];
      if (!column) {
        throw new Error("Unknown initial wallet entitlement column");
      }
      return {
        name: sql.identifier(column.name),
        value: value instanceof SQL ? value : sql.param(value, column),
      };
    });
  return sql`INSERT INTO ${orgPlanEntitlements} (${sql.join(
    cells.map((cell) => {
      return cell.name;
    }),
    sql`, `,
  )})
    SELECT ${sql.join(
      cells.map((cell) => {
        return cell.value;
      }),
      sql`, `,
    )} FROM ${source} WHERE true
    ON CONFLICT (org_id) DO NOTHING RETURNING org_id`;
}

function feishuOAuthWallet(
  args: TimedFeishuOAuthPublicationInput,
  member: ReturnType<typeof feishuOAuthMember>,
) {
  const query = new QueryBuilder();
  const created = query.$with("oauth_created_wallet", {
    orgId: orgMetadata.orgId,
  }).as(sql`
    INSERT INTO ${orgMetadataCanonicalWrites} (org_id)
    SELECT ${args.state.orgId} FROM ${member.claimed} WHERE true ON CONFLICT DO NOTHING RETURNING org_id
  `);
  const entitlement = query
    .$with("oauth_wallet_entitlement", { orgId: orgPlanEntitlements.orgId })
    .as(feishuWalletEntitlementSql(args.state.orgId, sql`${created}`));
  const identity = query
    .select({ orgId: created.orgId })
    .from(created)
    .unionAll(
      query
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.state.orgId)),
    );
  return { created, entitlement, identity };
}

function feishuOAuthAccount(
  args: TimedFeishuOAuthPublicationInput,
  member: ReturnType<typeof feishuOAuthMember>,
  wallet: ReturnType<typeof feishuOAuthWallet>,
) {
  const query = new QueryBuilder();
  const owner = and(
    eq(accounts.orgId, args.state.orgId),
    eq(accounts.userId, args.state.userId),
    eq(accounts.customConnectorId, args.connector.id),
  );
  const scopes =
    args.token.scopes === null ? null : JSON.stringify(args.token.scopes);
  const expires = sql.param(args.token.expiresAt, accounts.tokenExpiresAt);
  const create = args.state.accountMutation.intent !== "reconnect";
  const displayName =
    args.state.accountMutation.intent === "add"
      ? (args.state.accountMutation.displayName ?? null)
      : null;
  const inserted = query.$with("oauth_inserted_account", { id: accounts.id })
    .as(sql`
    INSERT INTO ${accounts} (id, org_id, user_id, custom_connector_id, connector_slug, is_default,
      display_name, auth_method, automatic_auth_type, storage_version, external_id, external_username,
      external_email, oauth_scopes, oauth_granted_scopes, token_expires_at, needs_reconnect, reconnect_reason, updated_at)
    SELECT ${member.claimed.connectorId}, ${args.state.orgId}, ${args.state.userId}, ${args.connector.id}::uuid,
      NULL, true, ${displayName}, 'oauth', NULL, ${args.connector.storageVersion}, ${args.userInfo.openId},
      ${args.userInfo.name}, ${args.token.userInfo?.email ?? null}, ${scopes}, NULL, ${expires}, false, NULL, ${sql.param(args.at, accounts.updatedAt)}
    FROM ${member.claimed} WHERE ${create} AND ${member.claimed.connectorId} = ${member.proposedAccountId}::uuid
      AND NOT EXISTS (${query.select({ id: accounts.id }).from(accounts).where(owner)})
      AND EXISTS (${wallet.identity}) AND (SELECT count(*) FROM ${wallet.entitlement}) >= 0
    ON CONFLICT (org_id, user_id, custom_connector_id)
      WHERE custom_connector_id IS NOT NULL AND is_default = true DO NOTHING RETURNING id
  `);
  const updated = query.$with("oauth_updated_account", { id: accounts.id })
    .as(sql`
    UPDATE ${accounts} SET auth_method = 'oauth', automatic_auth_type = NULL,
      storage_version = ${args.connector.storageVersion}, external_id = ${args.userInfo.openId},
      external_username = ${args.userInfo.name}, external_email = ${args.token.userInfo?.email ?? null},
      oauth_scopes = ${scopes}, oauth_granted_scopes = NULL, token_expires_at = ${expires},
      needs_reconnect = false, reconnect_reason = NULL, updated_at = ${sql.param(args.at, members.updatedAt)}
    FROM ${member.claimed} WHERE ${accounts.id} = ${member.claimed.connectorId} AND ${owner}
      AND (${!create} OR ${member.claimed.connectorId} <> ${member.proposedAccountId}::uuid)
      AND EXISTS (${wallet.identity}) AND (SELECT count(*) FROM ${inserted}) >= 0
    RETURNING ${accounts.id}
  `);
  const accepted = query.$with("oauth_account").as(
    query
      .select({ id: inserted.id })
      .from(inserted)
      .unionAll(query.select({ id: updated.id }).from(updated)),
  );
  return {
    inserted,
    updated,
    accepted,
    proposedAccountId: member.proposedAccountId,
  };
}

function feishuOAuthCredentials(
  args: TimedFeishuOAuthPublicationInput,
  encrypted: EncryptedFeishuTokens | null,
  account: ReturnType<typeof feishuOAuthAccount>,
) {
  const query = new QueryBuilder();
  const removedSecrets = query.$with("oauth_removed_secrets", {
    id: secrets.id,
  }).as(sql`
    DELETE FROM ${secrets} WHERE connector_id IN (SELECT id FROM ${account.accepted}) RETURNING id
  `);
  const removedVariables = query.$with("oauth_removed_variables", {
    id: variables.id,
  }).as(sql`
    DELETE FROM ${variables} WHERE connector_id IN (SELECT id FROM ${account.accepted})
      AND (SELECT count(*) FROM ${removedSecrets}) >= 0 RETURNING id
  `);
  const builtin = query.$with("oauth_removed_builtin_binding", {
    id: builtinConnectorAccountOauthBindings.connectorAccountId,
  }).as(sql`
    DELETE FROM ${builtinConnectorAccountOauthBindings} WHERE connector_account_id IN (SELECT id FROM ${account.accepted})
      AND (SELECT count(*) FROM ${removedVariables}) >= 0 RETURNING connector_account_id
  `);
  const rows =
    encrypted === null
      ? []
      : connectionTokenRows({
          ...args.state,
          connectionId: account.proposedAccountId,
          encrypted,
        });
  const input =
    rows.length === 0
      ? sql`SELECT NULL::text AS name, NULL::text AS encrypted_value WHERE false`
      : sql`VALUES ${sql.join(
          rows.map((row) => {
            return sql`(${row.name}, ${row.encryptedValue})`;
          }),
          sql`, `,
        )}`;
  const inserted = query.$with("oauth_inserted_secrets", { id: secrets.id })
    .as(sql`
    INSERT INTO ${secrets} (name, encrypted_value, type, connector_id, user_id, org_id)
    SELECT token.name, token.encrypted_value, 'connector', ${account.accepted.id}, ${args.state.userId}, ${args.state.orgId}
    FROM ${account.accepted} CROSS JOIN (${input}) AS token(name, encrypted_value)
    WHERE (SELECT count(*) FROM ${builtin}) >= 0 RETURNING id
  `);
  const custom = query.$with("oauth_removed_custom_binding", {
    id: customConnectorAccountOauthBindings.connectorAccountId,
  }).as(sql`
    DELETE FROM ${customConnectorAccountOauthBindings} WHERE connector_account_id IN (SELECT id FROM ${account.accepted})
      AND (SELECT count(*) FROM ${inserted}) >= 0 RETURNING connector_account_id
  `);
  return {
    removedSecrets,
    removedVariables,
    builtin,
    inserted,
    custom,
    expected: rows.length,
  };
}

function feishuGrantBundleSql(
  definition: ReturnType<typeof feishuOAuthAdmission>["definition"],
): SQL {
  const prefix = sql`CASE WHEN ${definition.slug} LIKE '_lark-%' THEN 'https://open.larksuite.com/open-apis/' ELSE 'https://open.feishu.cn/open-apis/' END`;
  return sql`CASE WHEN ${definition.slug} ~ ${"^_(feishu|lark)-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"}
    AND ${definition.authMode} = 'oauth' AND ${definition.providerAdapter} = 'feishu'
    AND jsonb_array_length(${definition.prefixTemplates}) = 1
    AND ${definition.prefixTemplates}->>0 = ${prefix}
    THEN 'builtin:feishu@1' ELSE ${definition.permissionBundleRef} END`;
}

function feishuOAuthGrant(
  args: TimedFeishuOAuthPublicationInput,
  admission: ReturnType<typeof feishuOAuthAdmission>,
  account: ReturnType<typeof feishuOAuthAccount>,
  after: SQL,
) {
  const query = new QueryBuilder();
  const bundle = feishuGrantBundleSql(admission.definition);
  const ordinary = sql`(${bundle}) IS NULL OR (${bundle}) = 'builtin:feishu@1'`;
  const scope = and(
    eq(grants.orgId, args.state.orgId),
    eq(grants.userId, args.state.userId),
    eq(grants.agentId, args.installation.defaultAgentId),
    eq(grants.customConnectorId, args.connector.id),
  );
  // Preserve the current permission array at the unique-key arbiter, including
  // an array committed while this statement waited. Never reinsert old grants.
  const inserted = query.$with("oauth_standard_grant", { id: grants.id })
    .as(sql`
    INSERT INTO ${grants} (org_id, user_id, agent_id, custom_connector_id, permission_names)
    SELECT ${args.state.orgId}, ${args.state.userId}, ${args.installation.defaultAgentId}::uuid,
      ${args.connector.id}::uuid, '{}'::text[] FROM ${admission.definition}
    WHERE (${ordinary}) AND EXISTS (SELECT 1 FROM ${account.accepted}) AND (SELECT count(*) FROM ${after}) >= 0
    ON CONFLICT (org_id, user_id, agent_id, custom_connector_id)
    DO UPDATE SET permission_names = ${grants.permissionNames} RETURNING id
  `);
  const retained = query.$with("oauth_selected_grant", { id: grants.id })
    .as(sql`
    UPDATE ${grants} SET permission_names = ${grants.permissionNames} FROM ${admission.definition}
    WHERE ${scope} AND NOT (${ordinary}) AND EXISTS (SELECT 1 FROM ${account.accepted})
      AND (SELECT count(*) FROM ${after}) >= 0 RETURNING ${grants.id}
  `);
  return { inserted, retained };
}

export function feishuOAuthPublicationSql(
  input: FeishuOAuthPublicationInput,
  encrypted: EncryptedFeishuTokens | null,
): SQL {
  const args = { ...input, at: nowDate() };
  const query = new QueryBuilder();
  const admission = feishuOAuthAdmission(args);
  const member = feishuOAuthMember(args, admission, encrypted !== null);
  const wallet = feishuOAuthWallet(args, member);
  const account = feishuOAuthAccount(args, member, wallet);
  const credentials = feishuOAuthCredentials(args, encrypted, account);
  const at = query.$with("oauth_reward_time", {
    at: sql`${sql.param(args.at, members.updatedAt)}`.as("at"),
  }).as(sql`
    SELECT ${sql.param(args.at, members.updatedAt)} AS at FROM ${account.accepted}
    WHERE (SELECT count(*) FROM ${credentials.custom}) >= 0
  `);
  const reward = completedGetStartedQuestPublication(
    {
      ...args.state,
      questKey: "connector",
      sourceKey: CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY,
    },
    args.at,
    query.select().from(at).getSQL(),
  );
  const claim = query.$with("claim", {}).as(reward.claim);
  const credited = query
    .$with("oauth_member_reward", {})
    .as(sql`${reward.grant} RETURNING id`);
  const tenant = query.$with("oauth_tenant", { id: feishuOrgInstallations.id })
    .as(sql`
    UPDATE ${feishuOrgInstallations} SET feishu_tenant_key = ${args.userInfo.tenantKey}, updated_at = ${sql.param(args.at, members.updatedAt)}
    WHERE id = ${args.state.installationId}::uuid AND ${!args.installation.tenantKey && Boolean(args.userInfo.tenantKey)}
      AND EXISTS (SELECT 1 FROM ${account.accepted}) AND (SELECT count(*) FROM ${credited}) >= 0 RETURNING id
  `);
  const grant = feishuOAuthGrant(args, admission, account, sql`${tenant}`);
  return query
    .with(
      admission.agent,
      admission.definition,
      member.removed,
      member.claimed,
      wallet.created,
      wallet.entitlement,
      account.inserted,
      account.updated,
      account.accepted,
      credentials.removedSecrets,
      credentials.removedVariables,
      credentials.builtin,
      credentials.inserted,
      credentials.custom,
      at,
      claim,
      credited,
      tenant,
      grant.inserted,
      grant.retained,
    )
    .select({
      agent: sql`${exists(query.select().from(admission.agent))}`
        .mapWith(zodDriverValueDecoder(boolean()))
        .as("agent"),
      credentialContract: sql`${exists(admission.contract)}`
        .mapWith(zodDriverValueDecoder(boolean()))
        .as("credentialContract"),
      definitionEnabled:
        sql`${exists(query.select().from(admission.definition).where(eq(admission.definition.enabled, true)))}`
          .mapWith(zodDriverValueDecoder(boolean()))
          .as("definitionEnabled"),
      foreignOwner: sql`${admission.foreign}`
        .mapWith(zodDriverValueDecoder(boolean()))
        .as("foreignOwner"),
      member:
        sql`(SELECT jsonb_build_object('connectionId', id, 'shouldNotify', NOT dm_welcome_sent) FROM ${member.claimed})`
          .mapWith(
            zodDriverValueDecoder(feishuOAuthPublicationRow.shape.member),
          )
          .as("member"),
      complete: sql`1 / CASE WHEN
      ((SELECT count(*) FROM ${member.removed}) = 0 OR EXISTS (SELECT 1 FROM ${member.claimed}))
      AND ((SELECT count(*) FROM ${member.claimed}) = (SELECT count(*) FROM ${account.accepted}))
      AND ((SELECT count(*) FROM ${credentials.inserted}) = ${credentials.expected} * (SELECT count(*) FROM ${account.accepted}))
      AND ((SELECT count(*) FROM ${grant.inserted}) + (SELECT count(*) FROM ${grant.retained}) = (SELECT count(*) FROM ${account.accepted}))
      THEN 1 ELSE 0 END`
        .mapWith(zodDriverValueDecoder(literal(1)))
        .as("complete"),
    })
    .from(sql`(SELECT 1) AS oauth_result_seed`)
    .getSQL();
}
