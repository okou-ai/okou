import { env, optionalEnv } from "../../lib/env";
import {
  cliAuthTestCodexOauthContract,
  cliAuthTestConnectorContract,
  cliAuthTestTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth-test";
import {
  connectorSlugSchema,
  type ConnectorAuthMethodId,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import type { ConnectorAuthMethodRuntimeConfig } from "@okouai/connectors/connector-config";
import {
  connectorAuthMethodAccessMetadata,
  connectorAuthMethodGrantMetadata,
  connectorAuthMethodRuntimeMetadata,
  type ConnectorOutputTarget,
} from "@okouai/connectors/connector-auth-method";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";

import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { db$, writeDb$, type Db } from "../external/db";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import {
  DEFAULT_TEST_EMAIL,
  issueCliToken$,
  testUserId$,
  testUserOrgId,
  ensureTestOrg$,
} from "../services/cli-auth.service";
import { upsertBuiltinConnectorTokenConnection$ } from "../services/connector-data.service";
import { connectorActionResolverForSnapshot } from "../services/connector-action-resolver.service";
import { loadConnectorRuntimeSlugSelection } from "../services/connector-catalog-slug-source.service";
import { getConnectorRuntimeConnector } from "../services/connector-catalog-runtime.service";
import { upsertPersonalModelProviderAccount$ } from "../services/model-provider-account.service";
import { userFeatureSwitchContext } from "../services/feature-switches.service";
import {
  isCodexAuthJsonFreePlanError,
  isCodexAuthJsonShapeError,
  parseCodexAuthJson,
} from "../services/codex-auth-json-parser";
import { safeSync } from "../utils";

const testTokenQuery$ = queryOf(cliAuthTestTokenContract.create);
const testConnectorBody$ = bodyResultOf(cliAuthTestConnectorContract.create);
const testConnectorQuery$ = queryOf(cliAuthTestConnectorContract.create);
const testCodexOauthBody$ = bodyResultOf(cliAuthTestCodexOauthContract.create);
const testCodexOauthQuery$ = queryOf(cliAuthTestCodexOauthContract.create);

function stringError(status: 400 | 404, error: string) {
  return { status, body: { error } };
}

function connectorOutputTargetKey(target: ConnectorOutputTarget): string {
  return `${target.kind}:${target.name}`;
}

function testConnectorTokenOutputs(args: {
  readonly connectorSlug: ConnectorSlug;
  readonly authMethodId: ConnectorAuthMethodId;
  readonly method: ConnectorAuthMethodRuntimeConfig;
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
}): Readonly<Record<string, string>> {
  const grantMetadata = connectorAuthMethodGrantMetadata(args.method);
  const runtimeMetadata = connectorAuthMethodRuntimeMetadata(args.method);

  const outputNameByTargetKey = new Map(
    Object.entries(grantMetadata.outputs).map(([outputName, output]) => {
      return [connectorOutputTargetKey(output.target), outputName];
    }),
  );
  const accessOutputName = runtimeMetadata.runtimeBindings
    .flatMap((binding) => {
      return binding.source.kind === "connector-secret"
        ? [outputNameByTargetKey.get(connectorOutputTargetKey(binding.source))]
        : [];
    })
    .find((outputName) => {
      return outputName !== undefined;
    });
  if (!accessOutputName) {
    throw new Error(
      `${args.connectorSlug} connector auth method ${args.authMethodId} does not expose a runtime token output`,
    );
  }

  const outputs: Record<string, string> = {
    [accessOutputName]: args.accessToken,
  };
  for (const [outputName, output] of Object.entries(grantMetadata.outputs)) {
    if (
      output.target.kind === "connector-variable" &&
      outputs[outputName] === undefined
    ) {
      outputs[outputName] =
        `${args.connectorSlug}-${args.authMethodId}-${outputName}`;
    }
  }
  if (!args.refreshToken) {
    return outputs;
  }

  const accessMetadata = connectorAuthMethodAccessMetadata(args.method);
  if (accessMetadata.kind !== "refresh-token") {
    return outputs;
  }

  const refreshOutputName = Object.values(accessMetadata.inputs)
    .flatMap((input) => {
      return input.source.kind === "connector-secret"
        ? [outputNameByTargetKey.get(connectorOutputTargetKey(input.source))]
        : [];
    })
    .find((outputName) => {
      return outputName !== undefined;
    });
  if (refreshOutputName) {
    outputs[refreshOutputName] = args.refreshToken;
  }
  return outputs;
}

function testEndpointAllowed(request: {
  header: (name: string) => string | undefined;
}) {
  if (isTestEndpointAllowed(request)) {
    return true;
  }

  if (env("ENV") === "preview") {
    // Vercel consumes the protection-bypass header before proxied web-preview
    // rewrites reach the API preview runtime. Production still stays denied.
    return (
      optionalEnv("USE_MOCK_CLAUDE") === "true" &&
      !!optionalEnv("VERCEL_AUTOMATION_BYPASS_SECRET")
    );
  }

  return false;
}

const createTestToken$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!testEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  const query = get(testTokenQuery$);
  const userId = await set(
    testUserId$,
    { email: query.email ?? DEFAULT_TEST_EMAIL, refresh: true },
    signal,
  );
  signal.throwIfAborted();
  const { orgId } = await set(ensureTestOrg$, userId, signal);
  signal.throwIfAborted();
  const issued = await set(
    issueCliToken$,
    { userId, orgId, name: "CI Test Token" },
    signal,
  );
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      access_token: issued.token,
      token_type: "Bearer" as const,
      expires_in: issued.expiresIn,
      user_id: userId,
    },
  };
});

const createTestConnector$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!testEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(testConnectorBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      if (
        bodyResult.response.body.error.message ===
        "Invalid JSON in request body"
      ) {
        return stringError(400, "Invalid JSON body");
      }
      return stringError(
        400,
        "connectorSlug, authMethod, and accessToken are required",
      );
    }

    const connectorParsed = connectorSlugSchema.safeParse(
      bodyResult.data.connectorSlug,
    );
    if (!connectorParsed.success) {
      return stringError(
        400,
        `Unknown connector slug: "${bodyResult.data.connectorSlug}"`,
      );
    }
    const connectorSlug = connectorParsed.data;
    const snapshot = await loadConnectorRuntimeSlugSelection(get(db$), {
      connectorSlugs: [connectorSlug],
    });
    signal.throwIfAborted();
    if (getConnectorRuntimeConnector(snapshot, connectorSlug) === undefined) {
      return stringError(400, `Unknown connector slug: "${connectorSlug}"`);
    }

    const query = get(testConnectorQuery$);
    const userId = await set(
      testUserId$,
      { email: query.email ?? DEFAULT_TEST_EMAIL, refresh: false },
      signal,
    );
    signal.throwIfAborted();
    const orgId = await get(testUserOrgId(userId));
    signal.throwIfAborted();
    if (!orgId) {
      return stringError(400, "Test user has no org — run test-token first");
    }

    const authMethod = bodyResult.data.authMethod;
    const resolver = await get(connectorActionResolverForSnapshot(snapshot));
    signal.throwIfAborted();
    const resolvedSlug = await resolver.resolveSlug({
      connectorSlug,
      requireExecutable: true,
    });
    signal.throwIfAborted();
    if (!resolvedSlug.ok) {
      return stringError(400, `Unknown connector slug: "${connectorSlug}"`);
    }
    const catalogMethod =
      resolvedSlug.runtimeConnector.catalogConnector.authMethods.find(
        (method) => {
          return method.id === authMethod;
        },
      );
    if (!catalogMethod) {
      return stringError(
        400,
        `${connectorSlug} connector does not configure auth method ${authMethod}`,
      );
    }
    if (
      catalogMethod.grantKind !== "auth-code" &&
      catalogMethod.grantKind !== "device-auth"
    ) {
      return stringError(
        400,
        `${connectorSlug} connector auth method ${authMethod} does not use an auth-code or device-auth grant`,
      );
    }
    const resolved = await resolver.resolveMethod({
      connectorSlug,
      authMethodId: authMethod,
      expectedGrantKind: catalogMethod.grantKind,
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      return stringError(
        400,
        `${connectorSlug} connector auth method ${authMethod} is not available`,
      );
    }

    const connectionResult = await set(
      upsertBuiltinConnectorTokenConnection$,
      {
        orgId,
        userId,
        runtimeMethod: resolved.runtimeMethod,
        snapshot: resolved.snapshot,
        account: { intent: "add" },
        outputs: testConnectorTokenOutputs({
          connectorSlug,
          authMethodId: authMethod,
          method: resolved.method,
          accessToken: bodyResult.data.accessToken,
          refreshToken: bodyResult.data.refreshToken,
        }),
        userInfo: {
          id: `e2e-test-${connectorSlug}`,
          username: `e2e-${connectorSlug}`,
          email: `e2e-${connectorSlug}@test.vm0.ai`,
        },
        oauthRequestedScopes: [],
        oauthGrantedScopes: [],
        expiresIn: bodyResult.data.expiresIn,
      },
      signal,
    );
    signal.throwIfAborted();
    if (connectionResult.status !== "connected") {
      return stringError(400, "Connector account could not be selected");
    }

    return {
      status: 200 as const,
      body: { ok: true as const, connectorSlug, orgId },
    };
  },
);

function seededCodexResponse(
  orgId: string,
  tokenExpiresAt: Date,
  modelProviderAccountId: string,
) {
  return {
    status: 200 as const,
    body: {
      ok: true as const,
      orgId,
      modelProviderAccountId,
      tokenExpiresAt: tokenExpiresAt.toISOString(),
    },
  };
}

async function readSeededCodexAccountProfile(
  db: Pick<Db, "select">,
  owner: { readonly orgId: string; readonly userId: string },
  accountId: string,
  signal: AbortSignal,
) {
  const [account] = await db
    .select({
      accountEmail: modelProviderAccounts.accountEmail,
      workspaceName: modelProviderAccounts.workspaceName,
      planType: modelProviderAccounts.planType,
    })
    .from(modelProviderAccounts)
    .where(
      and(
        eq(modelProviderAccounts.orgId, owner.orgId),
        eq(modelProviderAccounts.userId, owner.userId),
        eq(modelProviderAccounts.type, "codex-oauth-token"),
        eq(modelProviderAccounts.externalAccountId, accountId),
        isNull(modelProviderAccounts.disconnectedAt),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return account;
}

async function updateSeededCodexAccountFlags(
  db: Db,
  accountId: string,
  flags: {
    readonly orgId: string;
    readonly userId: string;
    readonly tokenExpiresAt: Date;
    readonly needsReconnect: boolean;
    readonly lastRefreshErrorCode: string | null;
  },
  signal: AbortSignal,
): Promise<void> {
  await db
    .update(modelProviderAccounts)
    .set({
      tokenExpiresAt: flags.tokenExpiresAt,
      needsReconnect: flags.needsReconnect,
      lastRefreshErrorCode: flags.lastRefreshErrorCode,
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(modelProviderAccounts.id, accountId),
        eq(modelProviderAccounts.orgId, flags.orgId),
        eq(modelProviderAccounts.userId, flags.userId),
        eq(modelProviderAccounts.type, "codex-oauth-token"),
      ),
    );
  signal.throwIfAborted();
}

const seedCodexOauth$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!testEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }

  const bodyResult = await get(testCodexOauthBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    if (
      bodyResult.response.body.error.message === "Invalid JSON in request body"
    ) {
      return stringError(400, "Invalid JSON body");
    }
    return stringError(400, "Invalid body shape");
  }

  const query = get(testCodexOauthQuery$);
  const userId = await set(
    testUserId$,
    { email: query.email ?? DEFAULT_TEST_EMAIL, refresh: false },
    signal,
  );
  signal.throwIfAborted();
  const orgId = await get(testUserOrgId(userId));
  signal.throwIfAborted();
  if (!orgId) {
    return stringError(400, "Test user has no org — run test-token first");
  }

  const featureSwitchContext = await get(
    userFeatureSwitchContext(orgId, userId),
  );
  signal.throwIfAborted();
  if ("authJson" in bodyResult.data) {
    const { authJson } = bodyResult.data;
    const parsedResult = safeSync(() => {
      return parseCodexAuthJson(authJson);
    });
    signal.throwIfAborted();
    if ("error" in parsedResult) {
      if (isCodexAuthJsonFreePlanError(parsedResult.error)) {
        return stringError(400, "Free plan rejected by parser");
      }
      if (isCodexAuthJsonShapeError(parsedResult.error)) {
        return stringError(
          400,
          `auth.json shape invalid: ${parsedResult.error.message}`,
        );
      }
      throw parsedResult.error;
    }

    const parsed = parsedResult.ok;
    const seededAccount = await set(
      upsertPersonalModelProviderAccount$,
      {
        orgId,
        userId,
        mode: { kind: "replace-active" },
        featureSwitchContext,
        type: "codex-oauth-token",
        authMethod: "auth_json",
        secretValues: {
          CHATGPT_ACCESS_TOKEN: parsed.accessToken,
          CHATGPT_REFRESH_TOKEN: parsed.refreshToken,
          CHATGPT_ACCOUNT_ID: parsed.accountId,
          CHATGPT_ID_TOKEN: parsed.idToken,
        },
        metadata: {
          tokenExpiresAt: parsed.tokenExpiresAt,
          workspaceName: parsed.workspaceName,
          planType: parsed.planType,
        },
      },
      signal,
    );
    signal.throwIfAborted();
    if ("status" in seededAccount) {
      return stringError(400, seededAccount.body.error.message);
    }
    return seededCodexResponse(
      orgId,
      parsed.tokenExpiresAt,
      seededAccount.provider.id,
    );
  }

  const tokenExpiresAt = new Date(
    nowDate().getTime() + (bodyResult.data.expiresIn ?? 600) * 1000,
  );
  // Legacy token inputs omit profile metadata. Preserve it only for the same
  // caller-owned account; never borrow another account's or member's profile.
  const existingAccount = await readSeededCodexAccountProfile(
    get(db$),
    { orgId, userId },
    bodyResult.data.accountId,
    signal,
  );
  const seededAccount = await set(
    upsertPersonalModelProviderAccount$,
    {
      orgId,
      userId,
      mode: { kind: "replace-active" },
      featureSwitchContext,
      type: "codex-oauth-token",
      authMethod: "auth_json",
      secretValues: {
        CHATGPT_ACCESS_TOKEN: bodyResult.data.accessToken,
        CHATGPT_REFRESH_TOKEN: bodyResult.data.refreshToken,
        CHATGPT_ACCOUNT_ID: bodyResult.data.accountId,
        CHATGPT_ID_TOKEN: bodyResult.data.idToken,
      },
      metadata: { ...existingAccount, tokenExpiresAt },
    },
    signal,
  );
  signal.throwIfAborted();

  if ("status" in seededAccount) {
    return stringError(400, seededAccount.body.error.message);
  }
  await updateSeededCodexAccountFlags(
    set(writeDb$),
    seededAccount.provider.id,
    {
      orgId,
      userId,
      tokenExpiresAt,
      needsReconnect: bodyResult.data.needsReconnect ?? false,
      lastRefreshErrorCode: bodyResult.data.lastRefreshErrorCode ?? null,
    },
    signal,
  );

  return seededCodexResponse(orgId, tokenExpiresAt, seededAccount.provider.id);
});

export const cliAuthTestRoutes: readonly RouteEntry[] = [
  { route: cliAuthTestTokenContract.create, handler: createTestToken$ },
  { route: cliAuthTestConnectorContract.create, handler: createTestConnector$ },
  { route: cliAuthTestCodexOauthContract.create, handler: seedCodexOauth$ },
];
