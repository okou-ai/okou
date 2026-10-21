import { z } from "zod";
import {
  initClient,
  type ApiFetcher,
} from "@okouai/api-contracts/contracts/trpc-contract";
import {
  connectorAccountsContract,
  connectorAccountConnectionSchema,
  connectorAccountTargetKey,
  type ConnectorAccountSelection,
  type ConnectorAccountMutationIntent,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  type SetCustomConnectorValuesBody,
  customConnectorValuesContract,
  customConnectorOAuth2Contract,
} from "@okouai/api-contracts/contracts/custom-connectors";
import {
  builtinConnectorOauthStartContract,
  builtinConnectorOpenIdStartContract,
  builtinConnectorAutomaticContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorCompletedOperationResponseSchema } from "@okouai/api-contracts/contracts/connector-schemas";
import type {
  ConnectorSlug,
  ConnectorAuthMethodId,
} from "@okouai/api-contracts/contracts/connector-identity";
import { getClientConfig } from "../core/client-factory";
import { handleManagementError } from "../../management-input";

export async function getConnectorManagementConfig() {
  const config = await getClientConfig();
  const api: ApiFetcher = async (args) => {
    try {
      return await config.api(args);
    } catch {
      throw new Error(
        "Connector management request failed. Check connectivity and the response contract; credential values are not displayed.",
      );
    }
  };
  return { ...config, api };
}

/** Parsing failures must not serialize credential-bearing response values. */
export function parseConnectorManagementResponse<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new Error(
      "Invalid connector management response. Credential values are not displayed.",
    );
  }
  return parsed.data;
}

function exactAccount(body: unknown, selection: ConnectorAccountSelection) {
  const account = parseConnectorManagementResponse(
    connectorAccountConnectionSchema.strip(),
    body,
  );
  if (
    account.id !== selection.connectionId ||
    connectorAccountTargetKey(account.target) !==
      connectorAccountTargetKey(selection.target)
  ) {
    throw new Error(
      "Connector account response does not match the requested target and connection ID.",
    );
  }
  return account;
}

export async function showConnectorAccount(
  selection: ConnectorAccountSelection,
) {
  const client = initClient(
    connectorAccountsContract,
    await getConnectorManagementConfig(),
  );
  const result = await client.connection({
    params: { connectionId: selection.connectionId },
    query: selection.target,
  });
  if (result.status !== 200)
    handleManagementError(result, "Failed to get connector account");
  return exactAccount(result.body, selection);
}

export async function renameConnectorAccount(
  selection: ConnectorAccountSelection,
  displayName: string | null,
) {
  const client = initClient(
    connectorAccountsContract,
    await getConnectorManagementConfig(),
  );
  const result = await client.rename({
    params: { connectionId: selection.connectionId },
    body: { target: selection.target, displayName },
  });
  if (result.status !== 200)
    handleManagementError(result, "Failed to rename connector account");
  return exactAccount(result.body, selection);
}

export async function setDefaultConnectorAccount(
  selection: ConnectorAccountSelection,
) {
  const client = initClient(
    connectorAccountsContract,
    await getConnectorManagementConfig(),
  );
  const result = await client.setDefault({
    params: { connectionId: selection.connectionId },
    body: { target: selection.target },
  });
  if (result.status !== 200)
    handleManagementError(result, "Failed to set default connector account");
  return exactAccount(result.body, selection);
}

export async function connectorAccountDeletionImpact(
  selection: ConnectorAccountSelection,
) {
  const client = initClient(
    connectorAccountsContract,
    await getConnectorManagementConfig(),
  );
  const result = await client.deletionImpact({
    params: { connectionId: selection.connectionId },
    query: selection.target,
  });
  if (result.status !== 200)
    handleManagementError(
      result,
      "Failed to inspect connector account deletion impact",
    );
  const impact = parseConnectorManagementResponse(
    z.object({
      connectionId: z.uuid(),
      explicitSelectionCount: z.number().int().nonnegative(),
      hasSibling: z.boolean(),
    }),
    result.body,
  );
  if (impact.connectionId !== selection.connectionId)
    throw new Error("Connector account impact response identity mismatch.");
  return impact;
}

export async function deleteConnectorAccount(
  selection: ConnectorAccountSelection,
) {
  const client = initClient(
    connectorAccountsContract,
    await getConnectorManagementConfig(),
  );
  const result = await client.delete({
    params: { connectionId: selection.connectionId },
    body: { target: selection.target },
  });
  if (result.status !== 200)
    handleManagementError(result, "Failed to delete connector account");
  const deleted = parseConnectorManagementResponse(
    z.object({
      deletedConnectionId: z.uuid(),
      resolvedSelectionCount: z.number().int().nonnegative(),
      promotedDefaultConnectionId: z.uuid().nullable(),
    }),
    result.body,
  );
  if (deleted.deletedConnectionId !== selection.connectionId)
    throw new Error("Deleted connector account response identity mismatch.");
  return deleted;
}

const memberConnectionSchema = z
  .object({
    id: z.uuid(),
    slug: z.string(),
    kind: z.enum(["http", "mcp"]),
    displayName: z.string(),
    authMode: z.enum(["manual", "none", "oauth", "automatic"]),
  })
  .and(connectorCompletedOperationResponseSchema);

export async function connectCustomConnectorMember(
  id: string,
  body: SetCustomConnectorValuesBody,
) {
  const client = initClient(
    customConnectorValuesContract,
    await getConnectorManagementConfig(),
  );
  const result = await client.set({ params: { id }, body });
  if (result.status !== 200)
    handleManagementError(result, "Failed to connect custom connector account");
  const connector = parseConnectorManagementResponse(
    memberConnectionSchema,
    result.body,
  );
  if (
    connector.id !== id ||
    (body.account.intent === "reconnect" &&
      connector.connectionId !== body.account.connectionId)
  )
    throw new Error("Custom connector account response identity mismatch.");
  return connector;
}

const authorizationUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && url.protocol !== "http:")
  )
    return false;
  return ![...url.searchParams.keys()].some((key) => {
    return /^(access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|token|client[_-]?secret|password)$/iu.test(
      key,
    );
  });
});
const authorizationSchema = z.object({
  authorizationUrl: authorizationUrlSchema,
  oauthAttemptId: z.uuid(),
  connectionId: z.uuid().optional(),
});
const automaticSchema = z.union([
  authorizationSchema.extend({ result: z.literal("authorization") }),
  z
    .object({ result: z.literal("connected") })
    .and(connectorCompletedOperationResponseSchema),
]);

function verifyAuthorizationAccount<T extends z.output<typeof automaticSchema>>(
  result: T,
  account: ConnectorAccountMutationIntent,
): T {
  if (account.intent === "reconnect") {
    const connectionId = result.connectionId;
    if (connectionId !== undefined && connectionId !== account.connectionId) {
      throw new Error(
        "Connector authorization response account identity mismatch.",
      );
    }
  }
  return result;
}

export async function startBuiltinConnectorAuthorization(
  slug: ConnectorSlug,
  authMethod: ConnectorAuthMethodId,
  grantKind: "auth-code" | "openid-auth" | "automatic",
  account: ConnectorAccountMutationIntent,
) {
  const config = await getConnectorManagementConfig();
  const request = {
    params: { connectorSlug: slug },
    body: { authMethod, account },
  };
  if (grantKind === "automatic") {
    const result = await initClient(
      builtinConnectorAutomaticContract,
      config,
    ).start(request);
    if (result.status !== 200)
      handleManagementError(result, "Failed to start connector authorization");
    return verifyAuthorizationAccount(
      parseConnectorManagementResponse(automaticSchema, result.body),
      account,
    );
  }
  const result =
    grantKind === "openid-auth"
      ? await initClient(builtinConnectorOpenIdStartContract, config).start(
          request,
        )
      : await initClient(builtinConnectorOauthStartContract, config).start(
          request,
        );
  if (result.status !== 200)
    handleManagementError(result, "Failed to start connector authorization");
  return verifyAuthorizationAccount(
    {
      result: "authorization" as const,
      ...parseConnectorManagementResponse(authorizationSchema, result.body),
    },
    account,
  );
}

export async function startCustomConnectorAuthorization(
  id: string,
  account: ConnectorAccountMutationIntent,
) {
  const result = await initClient(
    customConnectorOAuth2Contract,
    await getConnectorManagementConfig(),
  ).start({ params: { id }, body: { account } });
  if (result.status !== 200)
    handleManagementError(
      result,
      "Failed to start custom connector authorization",
    );
  return verifyAuthorizationAccount(
    parseConnectorManagementResponse(
      z.preprocess((value) => {
        if (
          typeof value === "object" &&
          value !== null &&
          !("result" in value) &&
          "authorizationUrl" in value
        )
          return { ...value, result: "authorization" };
        return value;
      }, automaticSchema),
      result.body,
    ),
    account,
  );
}
