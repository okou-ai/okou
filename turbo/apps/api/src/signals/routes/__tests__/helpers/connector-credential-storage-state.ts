import {
  testConnectorCredentialStorageStateContract,
  type TestConnectorCredentialStorageStateActionBody,
  type TestConnectorCredentialStorageStateActionResponse,
} from "@okouai/api-contracts/contracts/test-connector-credential-storage-state";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { createApp } from "../../../../app-factory";
import { setupApp } from "../../../../__tests__/test-helpers";
import { testConnectorCredentialStorageStateRoutes } from "../../test-connector-credential-storage-state";

async function postAction(
  context: TestContext,
  body: TestConnectorCredentialStorageStateActionBody,
): Promise<TestConnectorCredentialStorageStateActionResponse> {
  const response = await accept(
    setupApp({
      context,
      routes: testConnectorCredentialStorageStateRoutes,
    })(testConnectorCredentialStorageStateContract).action({
      body,
    }),
    [200],
  );
  return response.body;
}

async function requestAction(
  context: TestContext,
  body: TestConnectorCredentialStorageStateActionBody,
): Promise<Response> {
  return await createApp({
    signal: context.signal,
    routes: testConnectorCredentialStorageStateRoutes,
  }).request(testConnectorCredentialStorageStateContract.action.path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function readConnectorCredentialStorageState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly secretNames?: readonly string[];
    readonly variableNames?: readonly string[];
  },
): Promise<TestConnectorCredentialStorageStateActionResponse> {
  return await postAction(context, {
    action: "read",
    org_id: args.orgId,
    user_id: args.userId,
    connector_slug: args.connectorSlug,
    secret_names: [...(args.secretNames ?? [])],
    variable_names: [...(args.variableNames ?? [])],
  });
}

export async function readCustomConnectorCredentialStorageParent(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly customConnectorId: string;
  },
): Promise<TestConnectorCredentialStorageStateActionResponse> {
  return await postAction(context, {
    action: "read-custom-parent",
    org_id: args.orgId,
    user_id: args.userId,
    custom_connector_id: args.customConnectorId,
  });
}

export async function readCustomConnectorOAuthStorageState(
  context: TestContext,
  state: string,
): Promise<TestConnectorCredentialStorageStateActionResponse> {
  return await postAction(context, {
    action: "read-custom-oauth-state",
    state,
  });
}

export async function seedCustomConnectorOAuthStateContext(
  context: TestContext,
  args: {
    readonly state: string;
    readonly orgId: string;
    readonly userId: string;
    readonly customConnectorId: string;
    readonly storageVersion: number;
    readonly redirectUri: string;
    readonly oauthContext: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await postAction(context, {
    action: "seed-custom-oauth-state-context",
    state: args.state,
    org_id: args.orgId,
    user_id: args.userId,
    custom_connector_id: args.customConnectorId,
    storage_version: args.storageVersion,
    redirect_uri: args.redirectUri,
    oauth_context: { ...args.oauthContext },
  });
}

export async function seedAutomaticOAuthBindingState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly customConnectorId: string;
    readonly connectorAccountId: string;
    readonly issuer: string;
    readonly resource: string;
    readonly resourceMetadataUrl: string | null;
    readonly tokenEndpoint: string;
    readonly clientId: string;
    readonly registration:
      | {
          readonly method: "cimd";
          readonly tokenEndpointAuthMethod: "none";
        }
      | {
          readonly method: "dcr";
          readonly registrationId: string;
          readonly tokenEndpointAuthMethod:
            | "none"
            | "client_secret_basic"
            | "client_secret_post";
          readonly encryptedClientSecret: string | null;
        };
  },
): Promise<void> {
  await postAction(context, {
    action: "seed-automatic-oauth-binding",
    org_id: args.orgId,
    user_id: args.userId,
    custom_connector_id: args.customConnectorId,
    connector_account_id: args.connectorAccountId,
    issuer: args.issuer,
    resource: args.resource,
    resource_metadata_url: args.resourceMetadataUrl,
    token_endpoint: args.tokenEndpoint,
    client_id: args.clientId,
    registration:
      args.registration.method === "cimd"
        ? {
            method: "cimd",
            token_endpoint_auth_method:
              args.registration.tokenEndpointAuthMethod,
          }
        : {
            method: "dcr",
            registration_id: args.registration.registrationId,
            token_endpoint_auth_method:
              args.registration.tokenEndpointAuthMethod,
            encrypted_client_secret: args.registration.encryptedClientSecret,
          },
  });
}

export async function readAutomaticOAuthBindingState(
  context: TestContext,
  connectorAccountId: string,
): Promise<
  NonNullable<
    TestConnectorCredentialStorageStateActionResponse["automatic_oauth_binding"]
  >
> {
  const response = await postAction(context, {
    action: "read-automatic-oauth-binding",
    connector_account_id: connectorAccountId,
  });
  if (!response.automatic_oauth_binding) {
    throw new Error("Automatic OAuth binding state was not returned");
  }
  return response.automatic_oauth_binding;
}

export async function readConnectorOAuthAccountMutation(
  context: TestContext,
  state: string,
): Promise<TestConnectorCredentialStorageStateActionResponse> {
  return await postAction(context, {
    action: "read-oauth-state-account-mutation",
    state,
  });
}

export async function deleteCustomConnectorCredentialValues(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly customConnectorId: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "delete-custom-credential-values",
    org_id: args.orgId,
    user_id: args.userId,
    custom_connector_id: args.customConnectorId,
  });
}

export async function clearFeishuConnectorOwnership(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly installationId: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "clear-feishu-connector-ownership",
    org_id: args.orgId,
    installation_id: args.installationId,
  });
}

export async function readFeishuMemberConnectorState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly installationId: string;
  },
): Promise<TestConnectorCredentialStorageStateActionResponse> {
  return await postAction(context, {
    action: "read-feishu-member-connector",
    org_id: args.orgId,
    user_id: args.userId,
    installation_id: args.installationId,
  });
}

export async function setFeishuMemberConnectorLink(
  context: TestContext,
  args: {
    readonly userId: string;
    readonly installationId: string;
    readonly connectorId: string | null;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-feishu-member-connector-link",
    user_id: args.userId,
    installation_id: args.installationId,
    connector_id: args.connectorId,
  });
}

export async function seedOwnedConnectorSecret(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly authMethod: string;
    readonly storageVersion: number;
    readonly name: string;
    readonly encryptedValue: string;
    readonly description: string | null;
  },
): Promise<string> {
  const response = await postAction(context, {
    action: "seed-owned-secret",
    org_id: args.orgId,
    user_id: args.userId,
    connector_slug: args.connectorSlug,
    auth_method: args.authMethod,
    storage_version: args.storageVersion,
    name: args.name,
    encrypted_value: args.encryptedValue,
    description: args.description,
  });
  if (!response.connector_id) {
    throw new Error("Connector storage test fixture id was not returned");
  }
  return response.connector_id;
}

export async function seedConnectorStorageRow(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly authMethod: string;
    readonly storageVersion: number;
  },
): Promise<string> {
  const response = await postAction(context, {
    action: "seed-connector",
    org_id: args.orgId,
    user_id: args.userId,
    connector_slug: args.connectorSlug,
    auth_method: args.authMethod,
    storage_version: args.storageVersion,
  });
  if (!response.connector_id) {
    throw new Error("Connector storage test fixture id was not returned");
  }
  return response.connector_id;
}

export async function seedCustomConnectorRuntimeConnectors(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId?: string;
    readonly customConnectors: readonly {
      readonly id: string;
      readonly slug: string;
      readonly displayName: string;
      readonly prefixTemplate: string;
    }[];
  },
): Promise<void> {
  await postAction(context, {
    action: "seed-custom-runtime-connectors",
    org_id: args.orgId,
    user_id: args.userId,
    ...(args.agentId === undefined ? {} : { agent_id: args.agentId }),
    custom_connectors: args.customConnectors.map((connector) => {
      return {
        id: connector.id,
        slug: connector.slug,
        display_name: connector.displayName,
        prefix_template: connector.prefixTemplate,
      };
    }),
  });
}

export async function setConnectorCredentialStorageState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly storageVersion: number;
    readonly tokenExpiresAt?: string | null;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-connector-state",
    org_id: args.orgId,
    user_id: args.userId,
    connector_slug: args.connectorSlug,
    storage_version: args.storageVersion,
    ...(args.tokenExpiresAt === undefined
      ? {}
      : { token_expires_at: args.tokenExpiresAt }),
  });
}

export async function setBuiltinOAuthScopeFacts(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorSlug: string;
    readonly connectorId: string;
    readonly oauthScopes: readonly string[];
    readonly oauthGrantedScopes: readonly string[] | null;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-builtin-oauth-scope-facts",
    org_id: args.orgId,
    user_id: args.userId,
    connector_slug: args.connectorSlug,
    connector_id: args.connectorId,
    oauth_scopes: [...args.oauthScopes],
    oauth_granted_scopes:
      args.oauthGrantedScopes === null ? null : [...args.oauthGrantedScopes],
  });
}

export async function setConnectorDefaultState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly isDefault: boolean;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-connector-default",
    org_id: args.orgId,
    user_id: args.userId,
    connector_id: args.connectorId,
    is_default: args.isDefault,
  });
}

export async function setConnectorExternalIdState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly externalId: string | null;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-connector-external-id",
    org_id: args.orgId,
    user_id: args.userId,
    connector_id: args.connectorId,
    external_id: args.externalId,
  });
}

export async function setConnectorAccountState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
    readonly needsReconnect: boolean;
    readonly storageVersion?: number;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-connector-account-state",
    org_id: args.orgId,
    user_id: args.userId,
    connector_id: args.connectorId,
    needs_reconnect: args.needsReconnect,
    ...(args.storageVersion === undefined
      ? {}
      : { storage_version: args.storageVersion }),
  });
}

export async function seedBuiltinThreadConnectorSelection(
  context: TestContext,
  args: {
    readonly chatThreadId: string;
    readonly connectorId: string;
    readonly connectorSlug: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "seed-builtin-thread-selection",
    chat_thread_id: args.chatThreadId,
    connector_id: args.connectorId,
    connector_slug: args.connectorSlug,
  });
}

export async function seedCustomThreadConnectorSelection(
  context: TestContext,
  args: {
    readonly chatThreadId: string;
    readonly connectorId: string;
    readonly customConnectorId: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "seed-custom-thread-selection",
    chat_thread_id: args.chatThreadId,
    connector_id: args.connectorId,
    custom_connector_id: args.customConnectorId,
  });
}

export async function readThreadConnectorSelectionState(
  context: TestContext,
  args: {
    readonly chatThreadId: string;
    readonly connectorId: string;
  },
): Promise<boolean> {
  const response = await postAction(context, {
    action: "read-thread-selection",
    chat_thread_id: args.chatThreadId,
    connector_id: args.connectorId,
  });
  if (response.selection_exists === undefined) {
    throw new Error("Thread connector selection state was not returned");
  }
  return response.selection_exists;
}

export async function setCustomConnectorCredentialStorageState(
  context: TestContext,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly customConnectorId: string;
    readonly authMethod: "none" | "manual" | "oauth";
    readonly storageVersion: number;
    readonly needsReconnect?: boolean;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-custom-parent-state",
    org_id: args.orgId,
    user_id: args.userId,
    custom_connector_id: args.customConnectorId,
    auth_method: args.authMethod,
    storage_version: args.storageVersion,
    ...(args.needsReconnect === undefined
      ? {}
      : { needs_reconnect: args.needsReconnect }),
  });
}

export async function setConnectorSecretOwner(
  context: TestContext,
  args: {
    readonly connectorId: string;
    readonly name: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-secret-owner",
    connector_id: args.connectorId,
    name: args.name,
    org_id: args.orgId,
    user_id: args.userId,
  });
}

export async function setConnectorVariableOwner(
  context: TestContext,
  args: {
    readonly connectorId: string;
    readonly name: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<void> {
  await postAction(context, {
    action: "set-variable-owner",
    connector_id: args.connectorId,
    name: args.name,
    org_id: args.orgId,
    user_id: args.userId,
  });
}

export async function requestSetConnectorVariableOwner(
  context: TestContext,
  args: {
    readonly connectorId: string;
    readonly name: string;
    readonly orgId: string;
    readonly userId: string;
  },
): Promise<Response> {
  return await requestAction(context, {
    action: "set-variable-owner",
    connector_id: args.connectorId,
    name: args.name,
    org_id: args.orgId,
    user_id: args.userId,
  });
}
