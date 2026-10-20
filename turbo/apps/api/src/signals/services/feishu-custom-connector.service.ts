import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitches } from "@okouai/db/schema/user-feature-switches";
import { preparedVolumePublicationSql } from "./storage-volume-publication-sql";
import { StorageVersionIdentityConflictError } from "./storage-version-registration.service";
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
import { and, eq } from "drizzle-orm";
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
import { writeDb$, type Db } from "../external/db";
import type { CapturedConnectorClientInvalidationAbort } from "./connector-client-invalidation.service";
import { deleteConnectorCredentialStorageConnection } from "./connector-credential-storage-write.service";
import { prepareCustomConnectorSkillVolume$ } from "./custom-connector-skill-volume.service";
import {
  FEISHU_CUSTOM_CONNECTOR_SKILL_METADATA,
  getFeishuCustomConnectorSlug,
} from "./feishu-custom-connector-skill-metadata";
import { commitConnectorRuntimeMutation } from "./connector-runtime-wakeup.service";
import {
  customConnectorDefinitionSelection,
  type CustomConnectorDefinitionRow,
} from "./custom-connector-definition-selection";
import type { Tx } from "../../lib/db-types";
import {
  customConnectorOAuthStateLockReadPlan,
  customConnectorOAuthStateValidationReadPlan,
  assertCustomConnectorOAuthStateRows,
} from "./custom-connector-oauth-write.service";
import type { PreparedServerSideVolume } from "./storage-volume-publication.service";
import {
  connectorAccountResolutionReadPlan,
  connectorAccountResolutionsFromRows,
  connectorAccountTargetKey,
  type ConnectorAccountResolutionRequest,
} from "./connector-account-resolution.service";

const FEISHU_AUTHORIZATION_HEADER = "Authorization";
const FEISHU_AUTHORIZATION_TEMPLATE = "Bearer {{oauth.access_token}}";

type DbTransaction = Tx;

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

interface ExistingFeishuCustomConnector {
  readonly connector: CustomConnectorDefinitionRow;
  readonly oauthConfig:
    typeof orgCustomConnectorOauthConfigs.$inferSelect | null;
}

interface ReconciledFeishuCustomConnector {
  readonly connectorId: string;
  readonly runtimeChanged: boolean;
}

interface PreparedFeishuCustomConnectorSkill {
  readonly connectorId: string;
  readonly volume: PreparedServerSideVolume;
}

type FeishuCustomConnectorReconciliation =
  | { readonly kind: "installation-missing" }
  | { readonly kind: "stale-target"; readonly connectorId: string }
  | {
      readonly kind: "reconciled";
      readonly connector: ReconciledFeishuCustomConnector;
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

async function createFeishuCustomConnector(
  tx: DbTransaction,
  args: EnsureFeishuCustomConnectorArgs,
  installation: FeishuConnectorInstallation,
  prepared: PreparedFeishuCustomConnectorSkill,
  signal: AbortSignal,
): Promise<ReconciledFeishuCustomConnector> {
  const oauthStateDb = tx;
  const oauthStateConnectors = [
    { connectorId: prepared.connectorId, orgId: args.orgId },
  ] as const;
  return await (async () => {
    const lockPlan =
      customConnectorOAuthStateLockReadPlan(oauthStateConnectors);
    await oauthStateDb
      .select(lockPlan.columns)
      .from(orgCustomConnectors)
      .where(lockPlan.condition)
      .orderBy(...lockPlan.orderBy)
      .for("update");
    const result = await (async () => {
      const [connector] = await tx
        .insert(orgCustomConnectors)
        .values({
          id: prepared.connectorId,
          orgId: args.orgId,
          slug: getFeishuCustomConnectorSlug(
            args.installationId,
            installation.platform,
          ),
          ...desiredConnectorDefinition(installation),
          skillStorageVersionId: prepared.volume.version.versionId,
          createdBy: installation.ownerUserId ?? args.userId,
        })
        .returning({ id: orgCustomConnectors.id });
      signal.throwIfAborted();
      if (!connector) {
        throw new Error("Expected Feishu custom connector to be created");
      }
      await tx.insert(orgCustomConnectorOauthConfigs).values({
        connectorId: connector.id,
        ...desiredOAuthConfig(installation),
      });
      signal.throwIfAborted();
      return {
        connectorId: connector.id,
        runtimeChanged: false,
      };
    })();
    const statePlan = customConnectorOAuthStateValidationReadPlan(
      lockPlan.condition,
    );
    const states = await oauthStateDb
      .select(statePlan.columns)
      .from(orgCustomConnectors)
      .leftJoin(orgCustomConnectorOauthConfigs, statePlan.join)
      .where(statePlan.condition);
    assertCustomConnectorOAuthStateRows(states);
    return result;
  })();
}

async function repairFeishuCustomConnector(
  tx: DbTransaction,
  installation: FeishuConnectorInstallation,
  existing: ExistingFeishuCustomConnector,
  skillStorageVersionId: string,
  signal: AbortSignal,
): Promise<ReconciledFeishuCustomConnector> {
  const oauthStateDb = tx;
  const oauthStateConnectors = [
    { connectorId: existing.connector.id, orgId: installation.orgId },
  ] as const;
  return await (async () => {
    const lockPlan =
      customConnectorOAuthStateLockReadPlan(oauthStateConnectors);
    await oauthStateDb
      .select(lockPlan.columns)
      .from(orgCustomConnectors)
      .where(lockPlan.condition)
      .orderBy(...lockPlan.orderBy)
      .for("update");
    const result = await (async () => {
      const credentialContractChanged =
        existing.connector.authMode !== "oauth" ||
        !isDeepStrictEqual(existing.connector.fields, []) ||
        !oauthConfigMatches(existing.oauthConfig, installation);
      await tx
        .update(orgCustomConnectors)
        .set({
          ...desiredConnectorDefinition(installation),
          skillStorageVersionId,
          storageVersion: credentialContractChanged
            ? existing.connector.storageVersion + 1
            : existing.connector.storageVersion,
          updatedAt: nowDate(),
        })
        .where(eq(orgCustomConnectors.id, existing.connector.id));
      signal.throwIfAborted();
      const oauthConfig = desiredOAuthConfig(installation);
      await tx
        .insert(orgCustomConnectorOauthConfigs)
        .values({
          connectorId: existing.connector.id,
          ...oauthConfig,
        })
        .onConflictDoUpdate({
          target: orgCustomConnectorOauthConfigs.connectorId,
          set: {
            ...oauthConfig,
            updatedAt: nowDate(),
          },
        });
      signal.throwIfAborted();
      return {
        connectorId: existing.connector.id,
        runtimeChanged: true,
      };
    })();
    const statePlan = customConnectorOAuthStateValidationReadPlan(
      lockPlan.condition,
    );
    const states = await oauthStateDb
      .select(statePlan.columns)
      .from(orgCustomConnectors)
      .leftJoin(orgCustomConnectorOauthConfigs, statePlan.join)
      .where(statePlan.condition);
    assertCustomConnectorOAuthStateRows(states);
    return result;
  })();
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

async function reconcileFeishuCustomConnector(
  tx: DbTransaction,
  args: EnsureFeishuCustomConnectorArgs,
  prepared: PreparedFeishuCustomConnectorSkill,
  signal: AbortSignal,
): Promise<FeishuCustomConnectorReconciliation> {
  const [installation] = await tx
    .select({
      orgId: feishuOrgInstallations.orgId,
      customConnectorId: feishuOrgInstallations.customConnectorId,
      ownerUserId: feishuOrgInstallations.ownerUserId,
      appId: feishuOrgInstallations.appId,
      platform: feishuOrgInstallations.platform,
      encryptedAppSecret: feishuOrgInstallations.encryptedAppSecret,
      botName: feishuOrgInstallations.botName,
    })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.id, args.installationId),
        eq(feishuOrgInstallations.orgId, args.orgId),
      ),
    )
    .for("update", { of: feishuOrgInstallations })
    .limit(1);
  signal.throwIfAborted();
  if (!installation) {
    return { kind: "installation-missing" };
  }

  const [existing] = installation.customConnectorId
    ? await tx
        .select({
          connector: customConnectorDefinitionSelection(),
          oauthConfig: orgCustomConnectorOauthConfigs,
        })
        .from(orgCustomConnectors)
        .leftJoin(
          orgCustomConnectorOauthConfigs,
          and(
            eq(
              orgCustomConnectorOauthConfigs.connectorId,
              orgCustomConnectors.id,
            ),
            eq(orgCustomConnectorOauthConfigs.orgId, orgCustomConnectors.orgId),
          ),
        )
        .where(
          and(
            eq(orgCustomConnectors.orgId, args.orgId),
            eq(orgCustomConnectors.id, installation.customConnectorId),
          ),
        )
        .for("update", { of: orgCustomConnectors })
        .limit(1)
    : [];
  signal.throwIfAborted();
  if (existing && existing.connector.id !== prepared.connectorId) {
    return {
      kind: "stale-target",
      connectorId: existing.connector.id,
    };
  }

  const { rowCount: published } = await tx.execute(
    preparedVolumePublicationSql(prepared.volume, nowDate()),
  );
  if (published !== 1) {
    throw new StorageVersionIdentityConflictError(
      prepared.volume.version.versionId,
    );
  }
  signal.throwIfAborted();
  const skillStorageVersionId = prepared.volume.version.versionId;

  let connector: ReconciledFeishuCustomConnector;
  if (!existing) {
    connector = await createFeishuCustomConnector(
      tx,
      args,
      installation,
      prepared,
      signal,
    );
  } else {
    const needsRepair =
      !connectorDefinitionMatches(
        existing.connector,
        installation,
        skillStorageVersionId,
      ) || !oauthConfigMatches(existing.oauthConfig, installation);
    connector =
      !args.configurationChanged && !needsRepair
        ? {
            connectorId: existing.connector.id,
            runtimeChanged: false,
          }
        : await repairFeishuCustomConnector(
            tx,
            installation,
            existing,
            skillStorageVersionId,
            signal,
          );
  }
  if (installation.customConnectorId !== connector.connectorId) {
    await tx
      .update(feishuOrgInstallations)
      .set({
        customConnectorId: connector.connectorId,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(feishuOrgInstallations.id, args.installationId),
          eq(feishuOrgInstallations.orgId, args.orgId),
        ),
      );
    signal.throwIfAborted();
  }
  return {
    kind: "reconciled",
    connector,
  };
}

export const ensureFeishuCustomConnector$ = command(
  async (
    { set },
    args: EnsureFeishuCustomConnectorArgs,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
    const installation = await (async () => {
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
    signal.throwIfAborted();
    if (!installation || installation.orgId !== args.orgId) {
      return null;
    }
    let connectorId = await (async (
      signal: AbortSignal,
    ): Promise<string | null> => {
      const [target] = await db
        .select(feishuCustomConnectorIdColumns())
        .from(feishuOrgInstallations)
        .where(feishuCustomConnectorIdCondition(args))
        .limit(1);
      signal.throwIfAborted();
      return target ? (target.customConnectorId ?? randomUUID()) : null;
    })(signal);
    while (connectorId) {
      const volume = await set(
        prepareCustomConnectorSkillVolume$,
        {
          orgId: args.orgId,
          connectorId,
          connectorSlug: getFeishuCustomConnectorSlug(
            args.installationId,
            installation.platform,
          ),
          displayName: FEISHU_PLATFORMS[installation.platform].name,
          skillMarkdown: feishuSkillMarkdown(installation.platform),
          skillName: installation.platform,
          skillDescription:
            FEISHU_CUSTOM_CONNECTOR_SKILL_METADATA.description.replaceAll(
              "Feishu",
              FEISHU_PLATFORMS[installation.platform].name,
            ),
        },
        signal,
      );
      signal.throwIfAborted();
      const prepared = { connectorId, volume };
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0162; new non-billing transactions are prohibited.
      const reconciliation = db.transaction(async (tx) => {
        return await reconcileFeishuCustomConnector(tx, args, prepared, signal);
      });
      let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
      const result = await commitConnectorRuntimeMutation(
        reconciliation,
        (attempt) => {
          return attempt.kind === "reconciled" &&
            attempt.connector.runtimeChanged
            ? {
                db,
                scope: { orgId: args.orgId },
                targets: [
                  {
                    kind: "custom",
                    customConnectorId: attempt.connector.connectorId,
                  },
                ],
              }
            : undefined;
        },
      );
      if (signal.aborted) {
        postCommitAbort = { reason: signal.reason };
      }
      if (result.kind === "installation-missing") {
        signal.throwIfAborted();
        return null;
      }
      if (result.kind === "stale-target") {
        signal.throwIfAborted();
        connectorId = result.connectorId;
        continue;
      }

      const connector = result.connector;
      if (postCommitAbort) {
        throw postCommitAbort.reason;
      }
      signal.throwIfAborted();
      return connector.connectorId;
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0163; new non-billing transactions are prohibited.
    const deletion = db.transaction(async (tx) => {
      const [installation] = await tx
        .select({
          id: feishuOrgInstallations.id,
          customConnectorId: feishuOrgInstallations.customConnectorId,
        })
        .from(feishuOrgInstallations)
        .where(
          and(
            eq(feishuOrgInstallations.orgId, args.orgId),
            eq(feishuOrgInstallations.id, args.installationId),
          ),
        )
        .for("update")
        .limit(1);
      signal.throwIfAborted();
      if (!installation) {
        return { installationDeleted: false, connectorId: null };
      }

      const connectorId = installation.customConnectorId;

      await tx
        .delete(feishuOrgInstallations)
        .where(
          and(
            eq(feishuOrgInstallations.orgId, args.orgId),
            eq(feishuOrgInstallations.id, args.installationId),
          ),
        );
      signal.throwIfAborted();
      if (!connectorId) {
        return { installationDeleted: true, connectorId: null };
      }
      const selectionDeletion = { customConnectorId: connectorId };
      await tx
        .delete(chatThreadConnectorSelections)
        .where(
          eq(
            chatThreadConnectorSelections.customConnectorId,
            selectionDeletion.customConnectorId,
          ),
        );
      signal.throwIfAborted();
      const [deletedConnector] = await tx
        .delete(orgCustomConnectors)
        .where(
          and(
            eq(orgCustomConnectors.orgId, args.orgId),
            eq(orgCustomConnectors.id, connectorId),
          ),
        )
        .returning({ id: orgCustomConnectors.id });
      signal.throwIfAborted();
      return {
        installationDeleted: true,
        connectorId: deletedConnector?.id ?? null,
      };
    });
    let postCommitAbort: CapturedConnectorClientInvalidationAbort | undefined;
    const deleted = await commitConnectorRuntimeMutation(deletion, (result) => {
      return result.connectorId
        ? {
            db,
            scope: { orgId: args.orgId },
            targets: [
              {
                kind: "custom",
                customConnectorId: result.connectorId,
              },
            ],
          }
        : undefined;
    });
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

interface DisconnectFeishuCustomConnectorOAuthConnectionArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly installationId: string;
  readonly memberConnectorId?: string | null;
  readonly feishuOpenId?: string;
}

export async function disconnectFeishuCustomConnectorOAuthConnection(
  db: Db,
  args: DisconnectFeishuCustomConnectorOAuthConnectionArgs,
  signal: AbortSignal,
): Promise<void> {
  const [installation] = await db
    .select({ customConnectorId: feishuOrgInstallations.customConnectorId })
    .from(feishuOrgInstallations)
    .where(
      and(
        eq(feishuOrgInstallations.orgId, args.orgId),
        eq(feishuOrgInstallations.id, args.installationId),
      ),
    )
    .for("update", { of: feishuOrgInstallations })
    .limit(1);
  signal.throwIfAborted();
  if (!installation?.customConnectorId) {
    return;
  }
  const memberConnectorId = await (async () => {
    const scope = {
      orgId: args.orgId,
      userId: args.userId,
      installationId: args.installationId,
      memberConnectorId: args.memberConnectorId,
      feishuOpenId: args.feishuOpenId,
    };
    const memberPlan = feishuOAuthMemberReadPlan(scope);
    const memberRows = memberPlan.needsRead
      ? await db
          .select(memberPlan.columns)
          .from(feishuOrgConnections)
          .where(memberPlan.condition)
          .limit(2)
      : [];
    const member = feishuOAuthMemberFromRows(scope, memberRows);
    if (!member) {
      return null;
    }
    const installationPlan = feishuOAuthInstallationReadPlan(scope);
    const [installation] = await db
      .select(installationPlan.columns)
      .from(feishuOrgInstallations)
      .where(installationPlan.condition)
      .limit(1);
    const customConnectorId = installation?.customConnectorId;
    if (!customConnectorId) {
      return null;
    }
    const accountScope = { ...scope, ...member, customConnectorId };
    const accountPlan = feishuOAuthAccountReadPlan(accountScope);
    const [exactRows, defaultRows] = await Promise.all([
      accountPlan.exactWhere
        ? db
            .select(accountPlan.columns)
            .from(connectors)
            .where(accountPlan.exactWhere)
        : [],
      accountPlan.defaultWhere
        ? db
            .select(accountPlan.columns)
            .from(connectors)
            .where(accountPlan.defaultWhere)
        : [],
    ]);
    const accountId = feishuOAuthAccountFromRows(accountPlan, {
      exactRows,
      defaultRows,
    });
    if (accountId === null) {
      return null;
    }
    const credentialPlan = feishuOAuthCredentialReadPlan({
      ...accountScope,
      memberConnectorId: accountId,
    });
    const [matchedConnection] = await db
      .select(credentialPlan.columns)
      .from(connectors)
      .innerJoin(orgCustomConnectors, credentialPlan.connectorJoin)
      .innerJoin(secrets, credentialPlan.secretJoin)
      .where(credentialPlan.condition)
      .limit(1);
    return matchedConnection?.id ?? null;
  })();
  signal.throwIfAborted();
  if (!memberConnectorId) {
    return;
  }
  const memberDeletionDb = db;
  const memberDeletionArgs = {
    connectorId: installation.customConnectorId,
    memberConnectorId,
    orgId: args.orgId,
    userId: args.userId,
  };
  await (async (): Promise<boolean> => {
    const [connection] = await memberDeletionDb
      .select({ id: connectors.id })
      .from(connectors)
      .where(
        and(
          eq(connectors.customConnectorId, memberDeletionArgs.connectorId),
          eq(connectors.id, memberDeletionArgs.memberConnectorId),
          eq(connectors.userId, memberDeletionArgs.userId),
          eq(connectors.orgId, memberDeletionArgs.orgId),
        ),
      )
      .for("update")
      .limit(1);
    signal.throwIfAborted();
    if (!connection) {
      return false;
    }
    await deleteConnectorCredentialStorageConnection(
      memberDeletionDb,
      { connectorId: connection.id },
      signal,
    );
    return true;
  })();
}
