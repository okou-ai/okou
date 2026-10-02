import { command } from "ccstate";
import {
  testConnectorCredentialStorageStateContract,
  type TestConnectorCredentialStorageStateActionBody,
} from "@okouai/api-contracts/contracts/test-connector-credential-storage-state";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { connectorOauthStates } from "@okouai/db/schema/connector-oauth-state";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { feishuOrgConnections } from "@okouai/db/schema/feishu-org-connection";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorDcrRegistrations } from "@okouai/db/schema/org-custom-connector-dcr-registration";
import { secrets } from "@okouai/db/schema/secret";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { variables } from "@okouai/db/schema/variable";
import { and, asc, eq, inArray } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$, type Db } from "../external/db";
import { connectorOAuthStateExpiresAt } from "../../lib/connector-oauth-state";
import type { RouteEntry } from "../route-entry";
import { parseCustomConnectorOAuthStateContext } from "../services/custom-connector-oauth2.service";
import { readCustomConnectorAutomaticOAuthBinding } from "../services/custom-connector-automatic-oauth.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const actionBody$ = bodyResultOf(
  testConnectorCredentialStorageStateContract.action,
);

/**
 * This route is explicitly mounted only by tests. Connector owner/version
 * metadata, account links, and historical compatibility states have no
 * production API, and cross-owner states cannot be constructed through one.
 * Keeping that exception here lets route tests exercise the real public
 * behavior without registering a production diagnostics surface.
 */
type ConnectorCredentialStorageAction<
  TAction extends TestConnectorCredentialStorageStateActionBody["action"],
> = Extract<TestConnectorCredentialStorageStateActionBody, { action: TAction }>;

function actionOk(extra: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...extra } };
}

function requiredConnectorCredentialOwnerId(
  connectorId: string | null,
): string {
  if (connectorId === null) {
    throw new Error("Connector credential is missing its owner");
  }
  return connectorId;
}

async function readState(
  db: Db,
  body: ConnectorCredentialStorageAction<"read">,
  signal: AbortSignal,
) {
  const [connector] = await db
    .select({
      id: connectors.id,
      storageVersion: connectors.storageVersion,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
        eq(connectors.connectorSlug, body.connector_slug),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  const secretRows =
    body.secret_names.length === 0
      ? []
      : await db
          .select({
            name: secrets.name,
            connectorId: secrets.connectorId,
            encryptedValue: secrets.encryptedValue,
            description: secrets.description,
          })
          .from(secrets)
          .where(
            and(
              eq(secrets.orgId, body.org_id),
              eq(secrets.userId, body.user_id),
              eq(secrets.type, "connector"),
              inArray(secrets.name, body.secret_names),
            ),
          );
  signal.throwIfAborted();
  const variableRows =
    body.variable_names.length === 0
      ? []
      : await db
          .select({
            name: variables.name,
            connectorId: variables.connectorId,
          })
          .from(variables)
          .where(
            and(
              eq(variables.orgId, body.org_id),
              eq(variables.userId, body.user_id),
              eq(variables.type, "connector"),
              inArray(variables.name, body.variable_names),
            ),
          );
  signal.throwIfAborted();
  return actionOk({
    connector: connector
      ? {
          id: connector.id,
          storage_version: connector.storageVersion,
        }
      : null,
    secrets: secretRows.map((row) => {
      return {
        name: row.name,
        connector_id: requiredConnectorCredentialOwnerId(row.connectorId),
        encrypted_value: row.encryptedValue,
        description: row.description,
      };
    }),
    variables: variableRows.map((row) => {
      return {
        name: row.name,
        connector_id: requiredConnectorCredentialOwnerId(row.connectorId),
      };
    }),
  });
}

async function readCustomParent(
  db: Db,
  body: ConnectorCredentialStorageAction<"read-custom-parent">,
  signal: AbortSignal,
) {
  const [connector] = await db
    .select({
      id: connectors.id,
      storageVersion: connectors.storageVersion,
      authMethod: connectors.authMethod,
      externalId: connectors.externalId,
      externalUsername: connectors.externalUsername,
      externalEmail: connectors.externalEmail,
      oauthScopes: connectors.oauthScopes,
      oauthGrantedScopes: connectors.oauthGrantedScopes,
      tokenExpiresAt: connectors.tokenExpiresAt,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
        eq(connectors.customConnectorId, body.custom_connector_id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  const secretRows = connector
    ? await db
        .select({
          name: secrets.name,
          connectorId: secrets.connectorId,
          encryptedValue: secrets.encryptedValue,
          description: secrets.description,
        })
        .from(secrets)
        .where(eq(secrets.connectorId, connector.id))
        .orderBy(asc(secrets.name))
    : [];
  signal.throwIfAborted();
  const variableRows = connector
    ? await db
        .select({
          name: variables.name,
          connectorId: variables.connectorId,
          value: variables.value,
        })
        .from(variables)
        .where(eq(variables.connectorId, connector.id))
        .orderBy(asc(variables.name))
    : [];
  signal.throwIfAborted();
  return actionOk({
    connector: connector
      ? {
          id: connector.id,
          storage_version: connector.storageVersion,
          auth_method: connector.authMethod,
          external_id: connector.externalId,
          external_username: connector.externalUsername,
          external_email: connector.externalEmail,
          oauth_scopes: connector.oauthScopes,
          oauth_granted_scopes: connector.oauthGrantedScopes,
          token_expires_at: connector.tokenExpiresAt?.toISOString() ?? null,
        }
      : null,
    secrets: secretRows.map((row) => {
      return {
        name: row.name,
        connector_id: requiredConnectorCredentialOwnerId(row.connectorId),
        encrypted_value: row.encryptedValue,
        description: row.description,
      };
    }),
    variables: variableRows.map((row) => {
      return {
        name: row.name,
        connector_id: requiredConnectorCredentialOwnerId(row.connectorId),
        value: row.value,
      };
    }),
  });
}

async function readCustomOAuthState(
  db: Db,
  body: ConnectorCredentialStorageAction<"read-custom-oauth-state">,
  signal: AbortSignal,
) {
  const [state] = await db
    .select({
      storageVersion: connectorOauthStates.storageVersion,
      oauthContext: connectorOauthStates.oauthContext,
    })
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, body.state))
    .limit(1);
  signal.throwIfAborted();
  if (!state) {
    return actionOk({ custom_oauth_state: null });
  }
  const context = parseCustomConnectorOAuthStateContext(state.oauthContext);
  return actionOk({
    custom_oauth_state: {
      storage_version: state.storageVersion,
      context_storage_version: context?.storageVersion ?? null,
      context_valid: context !== null,
      ...(context ? { auth_mode: context.authMode } : {}),
    },
  });
}

async function seedAutomaticOAuthBinding(
  db: Db,
  body: ConnectorCredentialStorageAction<"seed-automatic-oauth-binding">,
  signal: AbortSignal,
) {
  await db.transaction(async (tx) => {
    await tx.insert(orgCustomConnectors).values({
      id: body.custom_connector_id,
      orgId: body.org_id,
      slug: `_${body.custom_connector_id.replaceAll("-", "").slice(0, 24)}`,
      displayName: "Automatic OAuth test connector",
      fields: [],
      headerInjections: [],
      queryInjections: [],
      authMode: "automatic",
      mcpEndpoint: "https://mcp.example.test",
      mcpTransport: "streamable-http",
      createdBy: body.user_id,
    });
    await tx.insert(connectors).values({
      id: body.connector_account_id,
      customConnectorId: body.custom_connector_id,
      authMethod: "oauth",
      storageVersion: 1,
      userId: body.user_id,
      orgId: body.org_id,
    });
    const registration = body.registration;
    if (registration.method === "dcr") {
      await tx.insert(orgCustomConnectorDcrRegistrations).values({
        id: registration.registration_id,
        orgId: body.org_id,
        customConnectorId: body.custom_connector_id,
        issuer: body.issuer,
        clientId: body.client_id,
        encryptedClientSecret: registration.encrypted_client_secret,
        tokenEndpointAuthMethod: registration.token_endpoint_auth_method,
        registeredScopes: ["read"],
        redirectUri:
          "https://app.example.test/api/custom-connectors/oauth2/callback",
        issuedAt: new Date("2026-08-31T00:00:00.000Z"),
      });
    }
    await tx.insert(customConnectorAccountOauthBindings).values({
      connectorAccountId: body.connector_account_id,
      customConnectorId: body.custom_connector_id,
      issuer: body.issuer,
      resource: body.resource,
      resourceMetadataUrl: body.resource_metadata_url,
      tokenEndpoint: body.token_endpoint,
      clientId: body.client_id,
      tokenEndpointAuthMethod: registration.token_endpoint_auth_method,
      registrationMethod: registration.method,
      dcrRegistrationId:
        registration.method === "dcr" ? registration.registration_id : null,
    });
  });
  signal.throwIfAborted();
  return actionOk({ connector_id: body.connector_account_id });
}

async function readAutomaticOAuthBinding(
  db: Db,
  body: ConnectorCredentialStorageAction<"read-automatic-oauth-binding">,
  signal: AbortSignal,
) {
  const [stored] = await db
    .select({
      registrationMethod:
        customConnectorAccountOauthBindings.registrationMethod,
    })
    .from(customConnectorAccountOauthBindings)
    .where(
      eq(
        customConnectorAccountOauthBindings.connectorAccountId,
        body.connector_account_id,
      ),
    )
    .limit(1);
  const binding = await readCustomConnectorAutomaticOAuthBinding(
    db,
    body.connector_account_id,
  );
  signal.throwIfAborted();
  return actionOk({
    automatic_oauth_binding: {
      exists: stored !== undefined,
      valid: binding !== null,
      registration_method: stored?.registrationMethod ?? null,
      ...(binding?.registrationMethod === "dcr"
        ? {
            dcr_client_secret_present: binding.dcrRegistration.hasClientSecret,
          }
        : {}),
    },
  });
}

async function readOAuthStateAccountMutation(
  db: Db,
  body: ConnectorCredentialStorageAction<"read-oauth-state-account-mutation">,
  signal: AbortSignal,
) {
  const [state] = await db
    .select({ accountMutation: connectorOauthStates.accountMutation })
    .from(connectorOauthStates)
    .where(eq(connectorOauthStates.state, body.state))
    .limit(1);
  signal.throwIfAborted();
  if (!state) {
    throw new Error("Expected connector OAuth state");
  }
  return actionOk({ account_mutation: state.accountMutation });
}

async function deleteCustomCredentialValues(
  db: Db,
  body: ConnectorCredentialStorageAction<"delete-custom-credential-values">,
  signal: AbortSignal,
) {
  const [connector] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
        eq(connectors.customConnectorId, body.custom_connector_id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!connector) {
    return {
      status: 400 as const,
      body: { error: "Custom connector storage test fixture was not found" },
    };
  }
  await db.transaction(async (tx) => {
    await tx
      .delete(secrets)
      .where(
        and(
          eq(secrets.connectorId, connector.id),
          eq(secrets.orgId, body.org_id),
          eq(secrets.userId, body.user_id),
          eq(secrets.type, "connector"),
        ),
      );
    await tx
      .delete(variables)
      .where(
        and(
          eq(variables.connectorId, connector.id),
          eq(variables.orgId, body.org_id),
          eq(variables.userId, body.user_id),
          eq(variables.type, "connector"),
        ),
      );
  });
  signal.throwIfAborted();
  return actionOk();
}

async function clearFeishuConnectorOwnership(
  db: Db,
  body: ConnectorCredentialStorageAction<"clear-feishu-connector-ownership">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(feishuOrgInstallations)
    .set({ customConnectorId: null })
    .where(
      and(
        eq(feishuOrgInstallations.orgId, body.org_id),
        eq(feishuOrgInstallations.id, body.installation_id),
      ),
    )
    .returning({ id: feishuOrgInstallations.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Feishu installation test fixture was not found" },
      };
}

async function readFeishuMemberConnector(
  db: Db,
  body: ConnectorCredentialStorageAction<"read-feishu-member-connector">,
  signal: AbortSignal,
) {
  const [connection] = await db
    .select({
      connectorId: feishuOrgConnections.connectorId,
      connectorExternalId: connectors.externalId,
      openId: feishuOrgConnections.feishuOpenId,
    })
    .from(feishuOrgConnections)
    .innerJoin(
      feishuOrgInstallations,
      and(
        eq(feishuOrgInstallations.id, feishuOrgConnections.installationId),
        eq(feishuOrgInstallations.orgId, body.org_id),
      ),
    )
    .leftJoin(connectors, eq(connectors.id, feishuOrgConnections.connectorId))
    .where(
      and(
        eq(feishuOrgConnections.installationId, body.installation_id),
        eq(feishuOrgConnections.userId, body.user_id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    feishu_member_connection: connection
      ? {
          connector_id: connection.connectorId,
          connector_external_id: connection.connectorExternalId,
          open_id: connection.openId,
        }
      : null,
  });
}

async function setFeishuMemberConnectorLink(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-feishu-member-connector-link">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(feishuOrgConnections)
    .set({ connectorId: body.connector_id })
    .where(
      and(
        eq(feishuOrgConnections.installationId, body.installation_id),
        eq(feishuOrgConnections.userId, body.user_id),
      ),
    )
    .returning({ id: feishuOrgConnections.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Feishu member connection test fixture was not found" },
      };
}

async function seedCustomOAuthStateContext(
  db: Db,
  body: ConnectorCredentialStorageAction<"seed-custom-oauth-state-context">,
  signal: AbortSignal,
) {
  await db.insert(connectorOauthStates).values({
    state: body.state,
    customConnectorId: body.custom_connector_id,
    storageVersion: body.storage_version,
    authMethod: "oauth",
    userId: body.user_id,
    orgId: body.org_id,
    redirectUri: body.redirect_uri,
    oauthContext: JSON.stringify(body.oauth_context),
    accountMutation: { intent: "add" },
    expiresAt: connectorOAuthStateExpiresAt(),
  });
  signal.throwIfAborted();
  return actionOk();
}

async function seedOwnedSecret(
  db: Db,
  body: ConnectorCredentialStorageAction<"seed-owned-secret">,
  signal: AbortSignal,
) {
  const connectorId = await db.transaction(async (tx) => {
    const [connector] = await tx
      .insert(connectors)
      .values({
        orgId: body.org_id,
        userId: body.user_id,
        connectorSlug: body.connector_slug,
        authMethod: body.auth_method,
        storageVersion: body.storage_version,
      })
      .returning({ id: connectors.id });
    if (!connector) {
      throw new Error("Expected connector storage test fixture");
    }
    await tx.insert(secrets).values({
      connectorId: connector.id,
      orgId: body.org_id,
      userId: body.user_id,
      name: body.name,
      encryptedValue: body.encrypted_value,
      description: body.description,
      type: "connector",
    });
    return connector.id;
  });
  signal.throwIfAborted();
  return actionOk({ connector_id: connectorId });
}

async function seedConnector(
  db: Db,
  body: ConnectorCredentialStorageAction<"seed-connector">,
  signal: AbortSignal,
) {
  const [connector] = await db
    .insert(connectors)
    .values({
      orgId: body.org_id,
      userId: body.user_id,
      connectorSlug: body.connector_slug,
      authMethod: body.auth_method,
      storageVersion: body.storage_version,
    })
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  if (!connector) {
    throw new Error("Expected connector storage test fixture");
  }
  return actionOk({ connector_id: connector.id });
}

async function seedCustomRuntimeConnectors(
  db: Db,
  body: ConnectorCredentialStorageAction<"seed-custom-runtime-connectors">,
  signal: AbortSignal,
) {
  await db.transaction(async (tx) => {
    await tx.insert(orgCustomConnectors).values(
      body.custom_connectors.map((connector) => {
        return {
          id: connector.id,
          orgId: body.org_id,
          slug: connector.slug,
          displayName: connector.display_name,
          prefixTemplates: [connector.prefix_template],
          fields: [
            {
              key: "optional_secret",
              label: "Optional secret",
              kind: "secret" as const,
              required: false,
            },
          ],
          headerInjections: [
            {
              name: "X-Connector",
              valueTemplate: "runtime-batch {{secrets.optional_secret}}",
            },
          ],
          queryInjections: [],
          authMode: "manual" as const,
          storageVersion: 1,
          createdBy: body.user_id,
        };
      }),
    );
    await tx.insert(connectors).values(
      body.custom_connectors.map((connector) => {
        return {
          orgId: body.org_id,
          userId: body.user_id,
          customConnectorId: connector.id,
          authMethod: "manual",
          storageVersion: 1,
        };
      }),
    );
    const agentId = body.agent_id;
    if (agentId) {
      await tx.insert(userCustomConnectors).values(
        body.custom_connectors.map((connector) => {
          return {
            orgId: body.org_id,
            userId: body.user_id,
            agentId,
            customConnectorId: connector.id,
            permissionNames: [] as string[],
          };
        }),
      );
    }
  });
  signal.throwIfAborted();
  return actionOk();
}

async function setConnectorState(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-connector-state">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(connectors)
    .set({
      storageVersion: body.storage_version,
      ...(body.token_expires_at === undefined
        ? {}
        : {
            tokenExpiresAt:
              body.token_expires_at === null
                ? null
                : new Date(body.token_expires_at),
          }),
    })
    .where(
      and(
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
        eq(connectors.connectorSlug, body.connector_slug),
      ),
    )
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return updated
    ? actionOk({ connector_id: updated.id })
    : {
        status: 400 as const,
        body: { error: "Connector storage test fixture was not found" },
      };
}

async function setBuiltinOAuthScopeFacts(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-builtin-oauth-scope-facts">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(connectors)
    .set({
      oauthScopes: JSON.stringify(body.oauth_scopes),
      oauthGrantedScopes:
        body.oauth_granted_scopes === null
          ? null
          : JSON.stringify(body.oauth_granted_scopes),
    })
    .where(
      and(
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
        eq(connectors.connectorSlug, body.connector_slug),
        eq(connectors.id, body.connector_id),
      ),
    )
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Connector storage test fixture was not found" },
      };
}

async function setConnectorDefault(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-connector-default">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(connectors)
    .set({ isDefault: body.is_default })
    .where(
      and(
        eq(connectors.id, body.connector_id),
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
      ),
    )
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Connector storage test fixture was not found" },
      };
}

async function setConnectorExternalId(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-connector-external-id">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(connectors)
    .set({ externalId: body.external_id })
    .where(
      and(
        eq(connectors.id, body.connector_id),
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
      ),
    )
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Connector storage test fixture was not found" },
      };
}

async function setConnectorAccountState(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-connector-account-state">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(connectors)
    .set({
      needsReconnect: body.needs_reconnect,
      ...(body.storage_version === undefined
        ? {}
        : { storageVersion: body.storage_version }),
    })
    .where(
      and(
        eq(connectors.id, body.connector_id),
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
      ),
    )
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Connector account test fixture was not found" },
      };
}

async function seedBuiltinThreadSelection(
  db: Db,
  body: ConnectorCredentialStorageAction<"seed-builtin-thread-selection">,
  signal: AbortSignal,
) {
  await db.insert(chatThreadConnectorSelections).values({
    chatThreadId: body.chat_thread_id,
    connectorId: body.connector_id,
    connectorSlug: body.connector_slug,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function seedCustomThreadSelection(
  db: Db,
  body: ConnectorCredentialStorageAction<"seed-custom-thread-selection">,
  signal: AbortSignal,
) {
  await db.insert(chatThreadConnectorSelections).values({
    chatThreadId: body.chat_thread_id,
    connectorId: body.connector_id,
    customConnectorId: body.custom_connector_id,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function readThreadSelection(
  db: Db,
  body: ConnectorCredentialStorageAction<"read-thread-selection">,
  signal: AbortSignal,
) {
  const [selection] = await db
    .select({ connectorId: chatThreadConnectorSelections.connectorId })
    .from(chatThreadConnectorSelections)
    .where(
      and(
        eq(chatThreadConnectorSelections.chatThreadId, body.chat_thread_id),
        eq(chatThreadConnectorSelections.connectorId, body.connector_id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ selection_exists: Boolean(selection) });
}

async function setCustomParentState(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-custom-parent-state">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(connectors)
    .set({
      authMethod: body.auth_method,
      storageVersion: body.storage_version,
      ...(body.needs_reconnect === undefined
        ? {}
        : { needsReconnect: body.needs_reconnect }),
    })
    .where(
      and(
        eq(connectors.orgId, body.org_id),
        eq(connectors.userId, body.user_id),
        eq(connectors.customConnectorId, body.custom_connector_id),
      ),
    )
    .returning({ id: connectors.id });
  signal.throwIfAborted();
  return updated
    ? actionOk({ connector_id: updated.id })
    : {
        status: 400 as const,
        body: { error: "Custom connector storage test fixture was not found" },
      };
}

async function setSecretOwner(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-secret-owner">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(secrets)
    .set({ connectorId: body.connector_id })
    .where(
      and(
        eq(secrets.orgId, body.org_id),
        eq(secrets.userId, body.user_id),
        eq(secrets.name, body.name),
        eq(secrets.type, "connector"),
      ),
    )
    .returning({ id: secrets.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Connector secret test fixture was not found" },
      };
}

async function setVariableOwner(
  db: Db,
  body: ConnectorCredentialStorageAction<"set-variable-owner">,
  signal: AbortSignal,
) {
  const [updated] = await db
    .update(variables)
    .set({ connectorId: body.connector_id })
    .where(
      and(
        eq(variables.orgId, body.org_id),
        eq(variables.userId, body.user_id),
        eq(variables.name, body.name),
        eq(variables.type, "connector"),
      ),
    )
    .returning({ id: variables.id });
  signal.throwIfAborted();
  return updated
    ? actionOk()
    : {
        status: 400 as const,
        body: { error: "Connector variable test fixture was not found" },
      };
}

async function mutateConnectorAccountCompatibilityState(
  db: Db,
  body: TestConnectorCredentialStorageStateActionBody,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "read-feishu-member-connector": {
      return await readFeishuMemberConnector(db, body, signal);
    }
    case "set-feishu-member-connector-link": {
      return await setFeishuMemberConnectorLink(db, body, signal);
    }
    case "set-connector-default": {
      return await setConnectorDefault(db, body, signal);
    }
    case "set-connector-external-id": {
      return await setConnectorExternalId(db, body, signal);
    }
    case "set-connector-account-state": {
      return await setConnectorAccountState(db, body, signal);
    }
    case "set-builtin-oauth-scope-facts": {
      return await setBuiltinOAuthScopeFacts(db, body, signal);
    }
    case "seed-builtin-thread-selection": {
      return await seedBuiltinThreadSelection(db, body, signal);
    }
    case "seed-custom-thread-selection": {
      return await seedCustomThreadSelection(db, body, signal);
    }
    case "read-thread-selection": {
      return await readThreadSelection(db, body, signal);
    }
    default: {
      return null;
    }
  }
}

async function mutateCustomOAuthFoundationState(
  db: Db,
  body: TestConnectorCredentialStorageStateActionBody,
  signal: AbortSignal,
) {
  switch (body.action) {
    case "seed-automatic-oauth-binding": {
      return await seedAutomaticOAuthBinding(db, body, signal);
    }
    case "read-automatic-oauth-binding": {
      return await readAutomaticOAuthBinding(db, body, signal);
    }
    case "seed-custom-oauth-state-context": {
      return await seedCustomOAuthStateContext(db, body, signal);
    }
    default: {
      return null;
    }
  }
}

const mutateConnectorCredentialStorageState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const db = set(writeDb$);
    const body = bodyResult.data;
    const customOAuthResult = await mutateCustomOAuthFoundationState(
      db,
      body,
      signal,
    );
    if (customOAuthResult) {
      return customOAuthResult;
    }
    const compatibilityResult = await mutateConnectorAccountCompatibilityState(
      db,
      body,
      signal,
    );
    if (compatibilityResult) {
      return compatibilityResult;
    }
    switch (body.action) {
      case "read": {
        return await readState(db, body, signal);
      }
      case "read-custom-parent": {
        return await readCustomParent(db, body, signal);
      }
      case "read-custom-oauth-state": {
        return await readCustomOAuthState(db, body, signal);
      }
      case "read-oauth-state-account-mutation": {
        return await readOAuthStateAccountMutation(db, body, signal);
      }
      case "delete-custom-credential-values": {
        return await deleteCustomCredentialValues(db, body, signal);
      }
      case "clear-feishu-connector-ownership": {
        return await clearFeishuConnectorOwnership(db, body, signal);
      }
      case "seed-owned-secret": {
        return await seedOwnedSecret(db, body, signal);
      }
      case "seed-connector": {
        return await seedConnector(db, body, signal);
      }
      case "seed-custom-runtime-connectors": {
        return await seedCustomRuntimeConnectors(db, body, signal);
      }
      case "set-connector-state": {
        return await setConnectorState(db, body, signal);
      }
      case "set-custom-parent-state": {
        return await setCustomParentState(db, body, signal);
      }
      case "set-secret-owner": {
        return await setSecretOwner(db, body, signal);
      }
      case "set-variable-owner": {
        return await setVariableOwner(db, body, signal);
      }
    }
  },
);

export const testConnectorCredentialStorageStateRoutes: readonly RouteEntry[] =
  [
    {
      route: testConnectorCredentialStorageStateContract.action,
      handler: mutateConnectorCredentialStorageState$,
    },
  ];
