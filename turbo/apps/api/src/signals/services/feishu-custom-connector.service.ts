import type { PreparedServerSideVolume } from "./storage-volume-publication.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { preparedVolumePublicationPlan } from "./storage-volume-publication-sql";
import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import {
  feishuInstallationConfigReadPlan,
  feishuInstallationConfigFromSecrets,
  feishuInstallationAvailabilityReadPlan,
  feishuInstallationEnabledFromRows,
} from "./feishu-config";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { command } from "ccstate";
import {
  and,
  count,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  exists,
  sql,
  type SQL,
  type WithSubquery,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import { FEISHU_OAUTH_SCOPES } from "@okouai/api-contracts/contracts/feishu-connect";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { orgCustomConnectorOauthConfigs } from "@okouai/db/schema/org-custom-connector-oauth-config";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { secrets } from "@okouai/db/schema/secret";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import type { CapturedConnectorClientInvalidationAbort } from "./connector-client-invalidation.service";
import { prepareCustomConnectorSkillVolume$ } from "./custom-connector-skill-volume.service";
import {
  FEISHU_CUSTOM_CONNECTOR_SKILL_METADATA,
  getFeishuCustomConnectorSlug,
} from "./feishu-custom-connector-skill-metadata";
import { publishConnectorRuntimeSyncWakeups$ } from "./connector-runtime-wakeup.service";
import {
  customConnectorDefinitionSelection,
  type CustomConnectorDefinitionRow,
} from "./custom-connector-definition-selection";
import {
  customConnectorCreateSource,
  customConnectorOAuthCreateSource,
} from "./custom-connector.service";
import {
  connectorAccountResolutionReadPlan,
  connectorAccountResolutionsFromRows,
  connectorAccountTargetKey,
  type ConnectorAccountResolutionRequest,
} from "./connector-account-resolution.service";

const FEISHU_AUTHORIZATION_HEADER = "Authorization";
const FEISHU_AUTHORIZATION_TEMPLATE = "Bearer {{oauth.access_token}}";

interface EnsureFeishuCustomConnectorArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly configurationChanged?: boolean;
}

interface FeishuConnectorInstallation {
  readonly platform: FeishuPlatform;
  readonly orgId: string;
  readonly customConnectorId: string | null;
  readonly ownerUserId: string | null;
  readonly appId: string;
  readonly encryptedAppSecret: string;
  readonly botName: string | null;
}

type FeishuCustomConnectorReconciliation =
  | { readonly kind: "installation-missing" }
  | { readonly kind: "stale-target"; readonly connectorId: string }
  | {
      readonly kind: "reconciled";
      readonly connector: {
        readonly connectorId: string;
        readonly runtimeChanged: boolean;
      };
    };

const FEISHU_SKILL_MARKDOWN = `Use Feishu OpenAPI as the connected user to find coworkers, work with cloud content, manage calendars, and organize tasks.

## Authentication and access

Base URL: \`${FEISHU_PLATFORMS.feishu.apiOrigin}/open-apis/\`

The connector automatically injects an OAuth \`Authorization: Bearer\` header for the connected Feishu user. Never request, print, store, or add an access token, and never call Feishu OAuth token endpoints yourself.

Every request runs with the connected user's identity. An operation succeeds only when both the granted OAuth scopes and that user's Feishu visibility or resource permissions allow it. Do not assume that a granted scope gives access to every person, chat, document, calendar, or task in the tenant.

## Available capabilities

- Identity and people: get the connected user's profile with \`GET /authen/v1/user_info\`; read basic contact and user information; resolve supplied email addresses or mobile numbers to user IDs; and search visible coworkers with \`GET /search/v1/user\`.
- Chats and members: list and inspect chats through \`/im/v1/chats\` and list chat members.
- Messages: this connection cannot read chat history or send messages as the connected user. For messaging, use the Feishu bot integration instead (\`okou feishu message\`, \`okou feishu upload-file\`, and \`okou feishu download-file\`), which acts as the Okou bot. The connected user can still read or change reactions on a known message and access message images or files.
- Drive and files: inspect and manage cloud-space files and permissions, upload or download files, import local files as Feishu cloud documents, export supported cloud documents, and upload or download document media.
- Docs: create, read, and edit Docs and document blocks under \`/docx/v1/documents\`; convert Markdown or HTML into document blocks; and read, add, reply to, update, resolve, or delete comments as allowed by the comment APIs.
- Sheets, Base, and Wiki: read and edit spreadsheets under \`/sheets/v3/spreadsheets\`, multidimensional tables under \`/bitable/v1/apps\`, and knowledge spaces or nodes under \`/wiki/v2\`.
- Search and presentations: search cloud documents visible to the connected user with \`POST /search/v2/doc_wiki/search\`; read, create, update, or remove presentation content under \`/slides/v1/presentations\`.
- Whiteboards: read existing nodes and create new nodes under \`/board/v1/whiteboards\`. This connection does not grant whiteboard node update or delete scopes.
- Calendars: use \`/calendar/v4\` for calendars, events, attendees, availability, access controls, and other calendar operations available to the connected user.
- Tasks: use \`/task/v2\` to read, create, update, and delete tasks and task lists, manage assignees or followers, create subtasks, manage task-list collaborators, and add or remove tasks from lists.

## Request patterns

Do not add an \`Authorization\` header to these requests; the connector supplies it.

### Identify the connected user

~~~bash
curl -sS "https://open.feishu.cn/open-apis/authen/v1/user_info"
~~~

### Search for a coworker

~~~bash
curl -sS -G "https://open.feishu.cn/open-apis/search/v1/user" \
  --data-urlencode "query=Alice" \
  --data-urlencode "page_size=20"
~~~

The user search endpoint cannot find external-tenant or departed users. Keep the returned ID type explicit when passing a result to another API.

### Search visible cloud documents

~~~bash
curl -sS -X POST \
  "https://open.feishu.cn/open-apis/search/v2/doc_wiki/search?page_size=20" \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{"query":"quarterly plan"}'
~~~

## Operating rules

1. Prefer lookup and read requests before writes. Resolve names or shared links to exact Feishu IDs or tokens before changing anything.
2. Preserve identifiers exactly, including \`open_id\`, \`user_id\`, \`union_id\`, \`chat_id\`, \`message_id\`, file or document tokens, block IDs, spreadsheet tokens, and Base app, table, or record IDs. Do not interchange ID types.
3. Use \`Content-Type: application/json; charset=utf-8\` for JSON requests and multipart form data for uploads. For import and export jobs, follow the documented upload/create-job/poll/download sequence.
4. HTTP success does not mean Feishu success. Check that the response \`code\` is \`0\` before using \`data\`; otherwise surface the Feishu \`code\` and \`msg\`.
5. Follow \`has_more\` and \`page_token\` until enough results have been collected. Respect rate limits and use bounded retries for throttling or transient server errors.
6. Before changing permissions, modifying shared content, deleting resources, or making broad calendar/task changes, summarize the intended target and impact and obtain confirmation when the user has not already made that intent explicit.
7. Consult the current Feishu API reference when an endpoint, payload, supported token type, or resource-specific limitation is uncertain.
`;

function feishuCustomConnectorDisplayName(
  botName: string | null,
  platform: FeishuPlatform,
): string {
  const name = FEISHU_PLATFORMS[platform].name;
  return botName ? `${name}-${botName}` : name;
}

function feishuSkillMarkdown(platform: FeishuPlatform): string {
  return FEISHU_SKILL_MARKDOWN.replaceAll(
    "Feishu",
    FEISHU_PLATFORMS[platform].name,
  )
    .replaceAll("https://open.feishu.cn", FEISHU_PLATFORMS[platform].apiOrigin)
    .replaceAll("okou feishu ", `okou ${platform} `);
}

function desiredConnectorDefinition(installation: FeishuConnectorInstallation) {
  return {
    displayName: feishuCustomConnectorDisplayName(
      installation.botName,
      installation.platform,
    ),
    prefixTemplates: [
      `${FEISHU_PLATFORMS[installation.platform].apiOrigin}/open-apis/`,
    ],
    fields: [],
    headerInjections: [
      {
        name: FEISHU_AUTHORIZATION_HEADER,
        valueTemplate: FEISHU_AUTHORIZATION_TEMPLATE,
      },
    ],
    queryInjections: [],
    authMode: "oauth" as const,
    enabled: true,
    permissionBundleRef: null,
    skillMarkdown: feishuSkillMarkdown(installation.platform),
  };
}

function desiredOAuthConfig(installation: FeishuConnectorInstallation) {
  return {
    orgId: installation.orgId,
    providerAdapter: "feishu" as const,
    clientId: installation.appId,
    encryptedClientSecret: installation.encryptedAppSecret,
    authorizationUrl: `${FEISHU_PLATFORMS[installation.platform].accountsOrigin}/open-apis/authen/v1/authorize`,
    tokenUrl: `${FEISHU_PLATFORMS[installation.platform].apiOrigin}/open-apis/authen/v2/oauth/token`,
    tokenEndpointAuthMethod: "client_secret_post" as const,
    pkceMethod: "none" as const,
    scopes: [...FEISHU_OAUTH_SCOPES],
    authorizationParams: {},
  };
}

function connectorDefinitionMatches(
  connector: CustomConnectorDefinitionRow,
  installation: FeishuConnectorInstallation,
  skillStorageVersionId: string,
): boolean {
  const desired = desiredConnectorDefinition(installation);
  return (
    connector.displayName === desired.displayName &&
    isDeepStrictEqual(connector.prefixTemplates, desired.prefixTemplates) &&
    isDeepStrictEqual(connector.fields, desired.fields) &&
    isDeepStrictEqual(connector.headerInjections, desired.headerInjections) &&
    isDeepStrictEqual(connector.queryInjections, desired.queryInjections) &&
    connector.authMode === desired.authMode &&
    connector.enabled === desired.enabled &&
    connector.permissionBundleRef === desired.permissionBundleRef &&
    connector.skillMarkdown === desired.skillMarkdown &&
    connector.skillStorageVersionId === skillStorageVersionId
  );
}

function oauthConfigMatches(
  config: typeof orgCustomConnectorOauthConfigs.$inferSelect | null,
  installation: FeishuConnectorInstallation,
): boolean {
  if (!config) {
    return false;
  }
  return (
    config.orgId === installation.orgId &&
    config.providerAdapter === "feishu" &&
    config.clientId === installation.appId &&
    config.encryptedClientSecret === installation.encryptedAppSecret &&
    config.authorizationUrl ===
      desiredOAuthConfig(installation).authorizationUrl &&
    config.tokenUrl === desiredOAuthConfig(installation).tokenUrl &&
    config.tokenEndpointAuthMethod === "client_secret_post" &&
    config.pkceMethod === "none" &&
    isDeepStrictEqual(config.scopes, FEISHU_OAUTH_SCOPES) &&
    isDeepStrictEqual(config.authorizationParams, {})
  );
}

function feishuCustomConnectorIdColumns() {
  return {
    customConnectorId: feishuOrgInstallations.customConnectorId,
  };
}

function feishuCustomConnectorIdCondition(
  args: EnsureFeishuCustomConnectorArgs,
) {
  return and(
    eq(feishuOrgInstallations.id, args.installationId),
    eq(feishuOrgInstallations.orgId, args.orgId),
  );
}

interface ExistingFeishuCustomConnector {
  readonly connector: CustomConnectorDefinitionRow;
  readonly oauthConfig:
    typeof orgCustomConnectorOauthConfigs.$inferSelect | null;
}
interface PreparedFeishuCustomConnectorSkill {
  readonly connectorId: string;
  readonly volume: PreparedServerSideVolume;
}
const loadFeishuConnectorConfig$ = command(
  async ({ get }, args: EnsureFeishuCustomConnectorArgs) => {
    const db = get(db$);
    return await (async () => {
      const plan = feishuInstallationConfigReadPlan(args.installationId);
      const [installation] = await db
        .select(plan.columns)
        .from(feishuOrgInstallations)
        .where(plan.condition)
        .limit(1);
      if (
        !installation ||
        !(await (async () => {
          const availability =
            feishuInstallationAvailabilityReadPlan(installation);
          if (availability.kind === "resolved") {
            return availability.enabled;
          }
          const rows = await db
            .select(availability.columns)
            .from(userFeatureSwitches)
            .where(availability.condition);
          return feishuInstallationEnabledFromRows(availability.scope, rows);
        })())
      ) {
        return null;
      }
      const context = { orgId: installation.orgId };
      const secrets = await Promise.all([
        decryptPersistentSecretValue(installation.encryptedAppSecret, context),
        decryptPersistentSecretValue(
          installation.encryptedVerificationToken,
          context,
        ),
        decryptPersistentSecretValue(installation.encryptedEncryptKey, context),
      ]);
      return feishuInstallationConfigFromSecrets(installation, secrets);
    })();
  },
);
function feishuSkillVolumeArgs(
  args: EnsureFeishuCustomConnectorArgs,
  connectorId: string,
  platform: FeishuPlatform,
) {
  return {
    orgId: args.orgId,
    connectorId,
    connectorSlug: getFeishuCustomConnectorSlug(args.installationId, platform),
    displayName: FEISHU_PLATFORMS[platform].name,
    skillMarkdown: feishuSkillMarkdown(platform),
    skillName: platform,
    skillDescription:
      FEISHU_CUSTOM_CONNECTOR_SKILL_METADATA.description.replaceAll(
        "Feishu",
        FEISHU_PLATFORMS[platform].name,
      ),
  };
}
function feishuReconciliationReadPlan(args: EnsureFeishuCustomConnectorArgs) {
  return {
    from: feishuOrgInstallations,
    columns: {
      orgId: feishuOrgInstallations.orgId,
      customConnectorId: feishuOrgInstallations.customConnectorId,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      appId: feishuOrgInstallations.appId,
      platform: feishuOrgInstallations.platform,
      encryptedAppSecret: feishuOrgInstallations.encryptedAppSecret,
      botName: feishuOrgInstallations.botName,
    },
    condition: feishuCustomConnectorIdCondition(args),
  };
}
function feishuExistingConnectorPlan(
  orgId: string,
  connectorId: string | null,
) {
  return {
    from: orgCustomConnectors,
    columns: {
      connector: customConnectorDefinitionSelection(),
      oauthConfig: orgCustomConnectorOauthConfigs,
    },
    join: and(
      eq(orgCustomConnectorOauthConfigs.connectorId, orgCustomConnectors.id),
      eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
    ),
    condition:
      connectorId === null
        ? undefined
        : and(
            eq(orgCustomConnectors.orgId, orgId),
            eq(orgCustomConnectors.id, connectorId),
          ),
  };
}
function feishuConnectorMutation(
  args: EnsureFeishuCustomConnectorArgs,
  installation: FeishuConnectorInstallation,
  prepared: PreparedFeishuCustomConnectorSkill,
  existing: ExistingFeishuCustomConnector | undefined,
) {
  const skillStorageVersionId = prepared.volume.version.versionId;
  if (!existing) {
    return {
      kind: "create",
      values: {
        id: prepared.connectorId,
        orgId: args.orgId,
        slug: getFeishuCustomConnectorSlug(
          args.installationId,
          installation.platform,
        ),
        ...desiredConnectorDefinition(installation),
        skillStorageVersionId,
        createdBy: installation.ownerUserId ?? args.userId,
      },
    } as const;
  }
  const needsRepair =
    !connectorDefinitionMatches(
      existing.connector,
      installation,
      skillStorageVersionId,
    ) || !oauthConfigMatches(existing.oauthConfig, installation);
  if (!args.configurationChanged && !needsRepair) {
    return { kind: "unchanged" } as const;
  }
  const changed =
    existing.connector.authMode !== "oauth" ||
    !isDeepStrictEqual(existing.connector.fields, []) ||
    !oauthConfigMatches(existing.oauthConfig, installation);
  return {
    kind: "repair",
    values: {
      ...desiredConnectorDefinition(installation),
      skillStorageVersionId,
      storageVersion: changed
        ? existing.connector.storageVersion + 1
        : existing.connector.storageVersion,
      updatedAt: nowDate(),
    },
    condition: eq(orgCustomConnectors.id, existing.connector.id),
  } as const;
}
function feishuOAuthConfigWrite(
  installation: FeishuConnectorInstallation,
  connectorId: string,
) {
  const config = desiredOAuthConfig(installation);
  return {
    values: { connectorId, ...config },
    conflict: {
      target: orgCustomConnectorOauthConfigs.connectorId,
      set: { ...config, updatedAt: nowDate() },
    },
  };
}
/** Bind prepared values to the installation fields that determine their authority. */
function feishuObservedInstallationCondition(
  installation: FeishuConnectorInstallation,
) {
  return and(
    eq(feishuOrgInstallations.orgId, installation.orgId),
    eq(feishuOrgInstallations.platform, installation.platform),
    eq(feishuOrgInstallations.appId, installation.appId),
    eq(
      feishuOrgInstallations.encryptedAppSecret,
      installation.encryptedAppSecret,
    ),
    sql`${feishuOrgInstallations.customConnectorId} IS NOT DISTINCT FROM ${installation.customConnectorId}::uuid`,
    sql`${feishuOrgInstallations.ownerUserId} IS NOT DISTINCT FROM ${installation.ownerUserId}`,
    sql`${feishuOrgInstallations.botName} IS NOT DISTINCT FROM ${installation.botName}`,
  );
}

/** Definition writers publish OAuth changes with this existing row version. */
function feishuObservedDefinitionCondition(
  connector: CustomConnectorDefinitionRow,
) {
  return and(
    eq(orgCustomConnectors.id, connector.id),
    eq(orgCustomConnectors.orgId, connector.orgId),
    eq(orgCustomConnectors.storageVersion, connector.storageVersion),
    gte(orgCustomConnectors.updatedAt, connector.updatedAt),
    lt(
      orgCustomConnectors.updatedAt,
      new Date(connector.updatedAt.getTime() + 1),
    ),
    eq(orgCustomConnectors.displayName, connector.displayName),
    eq(orgCustomConnectors.prefixTemplates, connector.prefixTemplates),
    eq(orgCustomConnectors.fields, connector.fields),
    eq(orgCustomConnectors.headerInjections, connector.headerInjections),
    eq(orgCustomConnectors.queryInjections, connector.queryInjections),
    eq(orgCustomConnectors.authMode, connector.authMode),
    eq(orgCustomConnectors.enabled, connector.enabled),
    sql`${orgCustomConnectors.permissionBundleRef} IS NOT DISTINCT FROM ${connector.permissionBundleRef}`,
    sql`${orgCustomConnectors.skillMarkdown} IS NOT DISTINCT FROM ${connector.skillMarkdown}`,
    sql`${orgCustomConnectors.skillStorageVersionId} IS NOT DISTINCT FROM ${connector.skillStorageVersionId}`,
  );
}

function feishuReconciliationPublicationPlan(
  args: EnsureFeishuCustomConnectorArgs,
  installed: FeishuConnectorInstallation,
  existing: ExistingFeishuCustomConnector | undefined,
  prepared: PreparedFeishuCustomConnectorSkill,
) {
  const query = new QueryBuilder();
  // Retain the original installation -> definition lock order. A waiting lock
  // must not authorize values prepared from a different installation/definition.
  const installation = query.$with("feishu_publication_installation").as(
    query
      .select({ id: feishuOrgInstallations.id })
      .from(feishuOrgInstallations)
      .where(
        and(
          feishuCustomConnectorIdCondition(args),
          feishuObservedInstallationCondition(installed),
        ),
      )
      .for("update")
      .limit(1),
  );
  const installationPresent = exists(query.select().from(installation));
  const definition = existing
    ? query.$with("feishu_publication_definition").as(
        query
          .select({
            id: orgCustomConnectors.id,
            authMode: orgCustomConnectors.authMode,
          })
          .from(orgCustomConnectors)
          .where(
            and(
              feishuObservedDefinitionCondition(existing.connector),
              installationPresent,
            ),
          )
          .for("update", { of: orgCustomConnectors })
          .limit(1),
      )
    : null;
  const authority = definition
    ? sql`${installationPresent} AND ${exists(query.select().from(definition))}`
    : installationPresent;
  const publication = preparedVolumePublicationPlan(
    prepared.volume,
    nowDate(),
    authority,
  );
  return {
    installation,
    definition,
    authority,
    publication,
    ctes: [
      installation,
      ...(definition ? [definition] : []),
      ...publication.ctes,
    ],
    ready: exists(query.select().from(publication.published)),
  };
}

const prepareFeishuReconciliation$ = command(
  async (
    { set },
    {
      args,
      prepared,
    }: {
      readonly args: EnsureFeishuCustomConnectorArgs;
      readonly prepared: PreparedFeishuCustomConnectorSkill;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const p = feishuReconciliationReadPlan(args);
    const [installed] = await db
      .select(p.columns)
      .from(p.from)
      .where(p.condition)
      .limit(1);
    signal.throwIfAborted();
    if (!installed) {
      return { kind: "installation-missing" as const };
    }
    const e = feishuExistingConnectorPlan(
      args.orgId,
      installed.customConnectorId,
    );
    const [existing] = installed.customConnectorId
      ? await db
          .select(e.columns)
          .from(e.from)
          .leftJoin(orgCustomConnectorOauthConfigs, e.join)
          .where(e.condition)
          .limit(1)
      : [];
    signal.throwIfAborted();
    if (existing && existing.connector.id !== prepared.connectorId) {
      return {
        kind: "stale-target" as const,
        connectorId: existing.connector.id,
      };
    }
    const mutation = feishuConnectorMutation(
      args,
      installed,
      prepared,
      existing,
    );
    return {
      kind: "prepared" as const,
      installed,
      mutation,
      plan: feishuReconciliationPublicationPlan(
        args,
        installed,
        existing,
        prepared,
      ),
    };
  },
);

function feishuDefinitionCreateSource(
  args: EnsureFeishuCustomConnectorArgs,
  installed: FeishuConnectorInstallation,
  prepared: PreparedFeishuCustomConnectorSkill,
) {
  return customConnectorCreateSource({
    connectorId: prepared.connectorId,
    orgId: args.orgId,
    userId: installed.ownerUserId ?? args.userId,
    slug: getFeishuCustomConnectorSlug(args.installationId, installed.platform),
    definition: {
      kind: "http",
      slug: undefined,
      ...desiredConnectorDefinition(installed),
    },
    storageVersion: 1,
    preparedSkill: prepared.volume,
  });
}

function feishuOAuthPublicationSource(
  installation: FeishuConnectorInstallation,
  definitionId: SQL,
) {
  return customConnectorOAuthCreateSource(
    definitionId,
    installation.orgId,
    desiredOAuthConfig(installation),
    installation.encryptedAppSecret,
  );
}

const publishedFeishuReconciliation$ = command(
  async (
    { set },
    input: {
      readonly result:
        { readonly guard: number; readonly applied: boolean } | undefined;
      readonly args: EnsureFeishuCustomConnectorArgs;
      readonly prepared: PreparedFeishuCustomConnectorSkill;
      readonly runtimeChanged: boolean;
    },
    signal: AbortSignal,
  ): Promise<FeishuCustomConnectorReconciliation> => {
    const { result, args, prepared } = input;
    if (result && !result.applied) {
      // Classify a lost installation target using a fresh read. The existing
      // outer retarget loop handles it; this command never retries a write.
      const current = await set(
        prepareFeishuReconciliation$,
        { args, prepared },
        signal,
      );
      if (current.kind !== "prepared") {
        return current;
      }
    }
    if (!result || result.guard !== 1 || !result.applied) {
      throw new Error(
        "Feishu connector configuration changed during publication",
      );
    }
    return {
      kind: "reconciled",
      connector: {
        connectorId: prepared.connectorId,
        runtimeChanged: input.runtimeChanged,
      },
    };
  },
);

function feishuPublicationResultSelection(
  plan: ReturnType<typeof feishuReconciliationPublicationPlan>,
  definition: WithSubquery,
  config: WithSubquery,
  linked: WithSubquery,
  needsLink: boolean,
) {
  const query = new QueryBuilder();
  const complete = sql`(
    ${eq(query.select({ count: count() }).from(plan.publication.published), 1)} AND
    ${eq(query.select({ count: count() }).from(definition), 1)} AND
    ${eq(query.select({ count: count() }).from(config), 1)} AND
    ${eq(query.select({ count: count() }).from(linked), needsLink ? 1 : 0)}
  )`;
  return {
    applied: sql`${plan.authority}`.mapWith(pgBooleanDecoder),
    guard:
      sql`(1 / CASE WHEN NOT (${plan.authority}) OR (${complete}) THEN 1 ELSE 0 END)::int`.mapWith(
        pgIntegerDecoder,
      ),
  };
}

function feishuPublishedDefinitionColumns() {
  return { id: orgCustomConnectors.id, authMode: orgCustomConnectors.authMode };
}

const ensureFeishuCustomConnector$ = command(
  async (
    { set },
    args: EnsureFeishuCustomConnectorArgs,
    prepared: PreparedFeishuCustomConnectorSkill,
    signal: AbortSignal,
  ): Promise<FeishuCustomConnectorReconciliation> => {
    const db = set(writeDb$);
    const preparation = await set(
      prepareFeishuReconciliation$,
      { args, prepared },
      signal,
    );
    if (preparation.kind !== "prepared") {
      return preparation;
    }
    const { installed, mutation, plan } = preparation;
    const definition =
      mutation.kind === "create"
        ? db.$with("feishu_published_definition").as(
            db
              .insert(orgCustomConnectors)
              .select(
                db
                  .select(
                    feishuDefinitionCreateSource(args, installed, prepared),
                  )
                  .from(plan.publication.published),
              )
              .returning(feishuPublishedDefinitionColumns()),
          )
        : mutation.kind === "repair"
          ? db
              .$with("feishu_published_definition")
              .as(
                db
                  .update(orgCustomConnectors)
                  .set(mutation.values)
                  .where(and(mutation.condition, plan.ready))
                  .returning(feishuPublishedDefinitionColumns()),
              )
          : db.$with("feishu_published_definition").as(
              db
                .select(feishuPublishedDefinitionColumns())
                .from(orgCustomConnectors)
                .where(
                  and(
                    eq(orgCustomConnectors.id, prepared.connectorId),
                    plan.ready,
                  ),
                ),
            );
    const oauth = feishuOAuthConfigWrite(installed, prepared.connectorId);
    const config =
      mutation.kind === "unchanged"
        ? db.$with("feishu_published_oauth").as(
            db
              .select({ id: orgCustomConnectorOauthConfigs.connectorId })
              .from(orgCustomConnectorOauthConfigs)
              .where(
                and(
                  eq(
                    orgCustomConnectorOauthConfigs.connectorId,
                    prepared.connectorId,
                  ),
                  eq(orgCustomConnectorOauthConfigs.orgId, args.orgId),
                  exists(db.select().from(definition)),
                ),
              ),
          )
        : db.$with("feishu_published_oauth").as(
            db
              .insert(orgCustomConnectorOauthConfigs)
              .select(
                db
                  .select(
                    feishuOAuthPublicationSource(
                      installed,
                      sql`${definition.id}`.mapWith(
                        orgCustomConnectorOauthConfigs.connectorId,
                      ),
                    ),
                  )
                  .from(definition),
              )
              .onConflictDoUpdate({
                ...oauth.conflict,
                setWhere: mutation.kind === "create" ? sql`false` : undefined,
              })
              .returning({ id: orgCustomConnectorOauthConfigs.connectorId }),
          );
    const configured = eq(db.select({ count: count() }).from(config), 1);
    const linked = db.$with("feishu_published_installation").as(
      db
        .update(feishuOrgInstallations)
        .set({ customConnectorId: prepared.connectorId, updatedAt: nowDate() })
        .where(
          and(
            feishuCustomConnectorIdCondition(args),
            configured,
            sql`${feishuOrgInstallations.customConnectorId} IS DISTINCT FROM ${prepared.connectorId}::uuid`,
          ),
        )
        .returning({ id: feishuOrgInstallations.id }),
    );
    signal.throwIfAborted();
    // Server-side assertion rolls back every dependent write, including Storage
    // HEAD, before a failed registration can become externally visible.
    const [result] = await db
      .with(...plan.ctes, definition, config, linked)
      .select(
        feishuPublicationResultSelection(
          plan,
          definition,
          config,
          linked,
          installed.customConnectorId !== prepared.connectorId,
        ),
      )
      .from(sql`(VALUES (1)) AS feishu_publication_result`);
    signal.throwIfAborted();
    return await set(
      publishedFeishuReconciliation$,
      { result, args, prepared, runtimeChanged: mutation.kind === "repair" },
      signal,
    );
  },
);

export const ensureManagedFeishuConnector$ = command(
  async (
    { set },
    args: EnsureFeishuCustomConnectorArgs,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const installation = await set(loadFeishuConnectorConfig$, args);
    signal.throwIfAborted();
    if (!installation || installation.orgId !== args.orgId) {
      return null;
    }
    const targetQuery = db
      .select(feishuCustomConnectorIdColumns())
      .from(feishuOrgInstallations);
    const [target] = await targetQuery
      .where(feishuCustomConnectorIdCondition(args))
      .limit(1);
    signal.throwIfAborted();
    let connectorId = target
      ? (target.customConnectorId ?? randomUUID())
      : null;
    while (connectorId) {
      const volume = await set(
        prepareCustomConnectorSkillVolume$,
        feishuSkillVolumeArgs(args, connectorId, installation.platform),
        signal,
      );
      signal.throwIfAborted();
      const prepared = { connectorId, volume };
      const reconciliation = set(
        ensureFeishuCustomConnector$,
        args,
        prepared,
        signal,
      );
      const result = await (async () => {
        const attempt = await reconciliation;
        if (attempt.kind === "reconciled" && attempt.connector.runtimeChanged) {
          await set(
            publishConnectorRuntimeSyncWakeups$,
            {
              scope: { orgId: args.orgId },
              targets: [
                {
                  kind: "custom",
                  customConnectorId: attempt.connector.connectorId,
                },
              ],
            },
            signal,
          );
        }
        return attempt;
      })();
      signal.throwIfAborted();
      if (result.kind === "installation-missing") {
        return null;
      }
      if (result.kind === "stale-target") {
        connectorId = result.connectorId;
        continue;
      }
      return result.connector.connectorId;
    }
    return null;
  },
);

export const deleteFeishuInstallationAndCustomConnector$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly installationId: string;
    },
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const installation = db.$with("deleted_feishu_installation").as(
      db
        .delete(feishuOrgInstallations)
        .where(
          and(
            eq(feishuOrgInstallations.orgId, args.orgId),
            eq(feishuOrgInstallations.id, args.installationId),
          ),
        )
        .returning({
          id: feishuOrgInstallations.id,
          customConnectorId: feishuOrgInstallations.customConnectorId,
        }),
    );
    const linkedConnector = db
      .select({ id: installation.customConnectorId })
      .from(installation);
    const selections = db
      .$with("deleted_feishu_connector_selections")
      .as(
        db
          .delete(chatThreadConnectorSelections)
          .where(
            inArray(
              chatThreadConnectorSelections.customConnectorId,
              linkedConnector,
            ),
          )
          .returning({ id: chatThreadConnectorSelections.connectorId }),
      );
    const connector = db.$with("deleted_feishu_connector").as(
      db
        .delete(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.orgId, args.orgId),
            inArray(orgCustomConnectors.id, linkedConnector),
            // Consume every selection before cascading account deletion, including
            // the zero-selection case and its existing NO ACTION constraints.
            gte(db.select({ count: count() }).from(selections), 0),
          ),
        )
        .returning({ id: orgCustomConnectors.id }),
    );
    // DELETE can return a link committed while it waited, although that new
    // connector is absent from this statement's snapshot. Reject the whole
    // deletion in that case; never commit an orphaned managed connector.
    const expectedConnectors = sql`CASE WHEN ${isNull(installation.customConnectorId)} THEN 0 ELSE 1 END`;
    const deletion = (async () => {
      const [result] = await db
        .with(installation, selections, connector)
        .select({
          connectorId: connector.id,
          guard:
            sql`(1 / CASE WHEN ${eq(db.select({ count: count() }).from(connector), expectedConnectors)} THEN 1 ELSE 0 END)::int`.mapWith(
              pgIntegerDecoder,
            ),
        })
        .from(installation)
        .leftJoin(connector, eq(connector.id, installation.customConnectorId));
      if (result && result.guard !== 1) {
        throw new Error(
          "Feishu installation deletion returned an invalid completion guard",
        );
      }
      return result
        ? { installationDeleted: true, connectorId: result.connectorId }
        : { installationDeleted: false, connectorId: null };
    })();
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const deleted = await (async () => {
      const result = await deletion;
      if (result.connectorId) {
        await set(
          publishConnectorRuntimeSyncWakeups$,
          {
            scope: { orgId: args.orgId },
            targets: [
              { kind: "custom", customConnectorId: result.connectorId },
            ],
          },
          signal,
        );
      }
      return result;
    })();
    if (signal.aborted) {
      postCommitAbort = { reason: signal.reason };
    }
    if (!deleted.installationDeleted) {
      signal.throwIfAborted();
      return false;
    }
    if (postCommitAbort) {
      throw postCommitAbort.reason;
    }
    signal.throwIfAborted();
    return true;
  },
);

export function feishuConnectorAccountMutationReadPlan(args: {
  readonly installationId: string;
  readonly userId: string;
}) {
  return {
    columns: { connectorId: feishuOrgConnections.connectorId },
    condition: and(
      eq(feishuOrgConnections.installationId, args.installationId),
      eq(feishuOrgConnections.userId, args.userId),
    ),
  };
}

export function feishuConnectorAccountMutationFromRows(
  connectionRows: readonly { readonly connectorId: string | null }[],
): ConnectorAccountMutationIntent {
  if (connectionRows.length > 1) {
    throw new Error("Multiple Feishu member connections found");
  }
  const connection = connectionRows[0];
  return connection?.connectorId
    ? { intent: "reconnect", connectionId: connection.connectorId }
    : { intent: "add" };
}

interface FeishuOAuthConnectionScope {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly memberConnectorId?: string | null;
  readonly feishuOpenId?: string;
}

export function feishuOAuthMemberReadPlan(args: FeishuOAuthConnectionScope) {
  return {
    from: feishuOrgConnections,
    needsRead:
      args.memberConnectorId === undefined || args.feishuOpenId === undefined,
    columns: {
      connectorId: feishuOrgConnections.connectorId,
      feishuOpenId: feishuOrgConnections.feishuOpenId,
    },
    condition: and(
      eq(feishuOrgConnections.installationId, args.installationId),
      eq(feishuOrgConnections.userId, args.userId),
    ),
  };
}

export function feishuOAuthMemberFromRows(
  args: FeishuOAuthConnectionScope,
  connectionRows: readonly Pick<
    typeof feishuOrgConnections.$inferSelect,
    "connectorId" | "feishuOpenId"
  >[],
) {
  let memberConnectorId = args.memberConnectorId;
  let feishuOpenId = args.feishuOpenId;
  if (memberConnectorId === undefined || feishuOpenId === undefined) {
    if (connectionRows.length !== 1) {
      return null;
    }
    const [connectionRow] = connectionRows;
    if (
      !connectionRow ||
      (memberConnectorId !== undefined &&
        memberConnectorId !== connectionRow.connectorId) ||
      (feishuOpenId !== undefined &&
        feishuOpenId !== connectionRow.feishuOpenId)
    ) {
      return null;
    }
    memberConnectorId = connectionRow.connectorId;
    feishuOpenId = connectionRow.feishuOpenId;
  }
  if (
    memberConnectorId === undefined ||
    memberConnectorId === null ||
    feishuOpenId === undefined
  ) {
    return null;
  }
  return { memberConnectorId, feishuOpenId };
}

export function feishuOAuthInstallationReadPlan(
  args: FeishuOAuthConnectionScope,
) {
  return {
    from: feishuOrgInstallations,
    columns: { customConnectorId: feishuOrgInstallations.customConnectorId },
    condition: and(
      eq(feishuOrgInstallations.orgId, args.orgId),
      eq(feishuOrgInstallations.id, args.installationId),
    ),
  };
}

export function feishuOAuthAccountReadPlan(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly customConnectorId: string;
  readonly memberConnectorId: string;
}) {
  const scope = { orgId: args.orgId, userId: args.userId };
  const request: ConnectorAccountResolutionRequest = {
    target: {
      kind: "custom",
      customConnectorId: args.customConnectorId,
    },
    selection: { kind: "exact", sourceId: args.memberConnectorId },
  };
  const targetKey = connectorAccountTargetKey(request.target);
  const plan = connectorAccountResolutionReadPlan({
    ...scope,
    requests: [request],
  });
  return { ...plan, targetKey };
}

export function feishuOAuthAccountFromRows(
  plan: ReturnType<typeof feishuOAuthAccountReadPlan>,
  rows: Omit<
    Parameters<typeof connectorAccountResolutionsFromRows>[0],
    "requests"
  >,
): string | null {
  const resolution = connectorAccountResolutionsFromRows({
    requests: plan.requests,
    ...rows,
  }).get(plan.targetKey);
  if (!resolution) {
    throw new Error("Expected one connector account resolution");
  }
  if (resolution.kind !== "resolved") {
    return null;
  }
  return resolution.account.connectorId;
}

export function feishuOAuthCredentialReadPlan(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly customConnectorId: string;
  readonly memberConnectorId: string;
  readonly feishuOpenId: string;
}) {
  return {
    columns: { id: connectors.id },
    connectorJoin: and(
      eq(connectors.customConnectorId, orgCustomConnectors.id),
      eq(connectors.orgId, orgCustomConnectors.orgId),
      eq(connectors.authMethod, orgCustomConnectors.authMode),
      eq(connectors.storageVersion, orgCustomConnectors.storageVersion),
    ),
    secretJoin: and(
      eq(secrets.connectorId, connectors.id),
      eq(secrets.name, "access_token"),
    ),
    condition: and(
      eq(orgCustomConnectors.id, args.customConnectorId),
      eq(orgCustomConnectors.orgId, args.orgId),
      eq(connectors.id, args.memberConnectorId),
      eq(connectors.userId, args.userId),
      eq(connectors.authMethod, "oauth"),
      eq(connectors.needsReconnect, false),
      eq(connectors.externalId, args.feishuOpenId),
    ),
  };
}
