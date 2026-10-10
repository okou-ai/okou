import { command } from "ccstate";
import type { OAuthClientMetadata } from "@modelcontextprotocol/client";
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES,
  type CustomConnectorAutomaticOAuthErrorCode,
} from "@okouai/api-contracts/contracts/custom-connectors";
import { connectors } from "@okouai/db/schema/connector";
import { customConnectorAccountOauthBindings } from "@okouai/db/schema/custom-connector-account-oauth-binding";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { orgCustomConnectorDcrRegistrations } from "@okouai/db/schema/org-custom-connector-dcr-registration";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";

import { nowDate, timestampWithoutTimeZone } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  decryptStoredSecretValue,
  encryptStoredSecretValue,
} from "./crypto.utils";
import {
  McpAutomaticOAuthError,
  prepareMcpAutomaticOAuthAuthorization,
  prepareMcpAutomaticOAuthReauthorization,
  exchangeMcpAutomaticOAuthCode,
  refreshMcpAutomaticOAuthToken,
  type McpAutomaticNoAuth,
  type McpAutomaticOAuthAuthorization,
  type McpAutomaticOAuthContext,
  type McpAutomaticOAuthDcrClientStore,
  type McpAutomaticOAuthDcrRegistration,
  type McpAutomaticOAuthDcrRegistrationInput,
} from "./mcp-automatic-oauth.service";

const oauthHttpsUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    return new URL(value).protocol === "https:";
  });

const tokenEndpointAuthMethodSchema = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);

const automaticOAuthBindingBaseSchema = z.object({
  connectorAccountId: z.string().uuid(),
  customConnectorId: z.string().uuid(),
  issuer: oauthHttpsUrlSchema,
  resource: oauthHttpsUrlSchema,
  resourceMetadataUrl: oauthHttpsUrlSchema.nullable(),
  tokenEndpoint: oauthHttpsUrlSchema,
  clientId: z.string().min(1),
  tokenEndpointAuthMethod: tokenEndpointAuthMethodSchema,
});

const dcrRegistrationSchema = z
  .object({
    id: z.string().uuid(),
    customConnectorId: z.string().uuid(),
    issuer: oauthHttpsUrlSchema,
    clientId: z.string().min(1),
    tokenEndpointAuthMethod: tokenEndpointAuthMethodSchema,
    hasClientSecret: z.boolean(),
    encryptedClientSecret: z.string().min(1).nullable(),
    registeredScopes: z.array(z.string().min(1)),
    redirectUri: oauthHttpsUrlSchema,
    issuedAt: z.date(),
    expiresAt: z.date().nullable(),
  })
  .refine((registration) => {
    return registration.tokenEndpointAuthMethod === "none"
      ? !registration.hasClientSecret &&
          registration.encryptedClientSecret === null
      : registration.hasClientSecret &&
          registration.encryptedClientSecret !== null;
  })
  .refine((registration) => {
    return (
      registration.expiresAt === null ||
      registration.expiresAt > registration.issuedAt
    );
  });

const customConnectorAutomaticOAuthBindingSchema = z.union([
  automaticOAuthBindingBaseSchema.extend({
    registrationMethod: z.literal("cimd"),
    dcrRegistration: z.null(),
    tokenEndpointAuthMethod: z.literal("none"),
  }),
  automaticOAuthBindingBaseSchema
    .extend({
      registrationMethod: z.literal("dcr"),
      dcrRegistration: dcrRegistrationSchema,
    })
    .refine((binding) => {
      return (
        binding.customConnectorId ===
          binding.dcrRegistration.customConnectorId &&
        binding.issuer === binding.dcrRegistration.issuer &&
        binding.clientId === binding.dcrRegistration.clientId &&
        binding.tokenEndpointAuthMethod ===
          binding.dcrRegistration.tokenEndpointAuthMethod
      );
    }),
]);

export type CustomConnectorAutomaticOAuthBinding = z.infer<
  typeof customConnectorAutomaticOAuthBindingSchema
>;

const automaticOAuthBindingPersistenceSchema = z
  .intersection(
    z.object({
      accountAuthMethod: z.literal("oauth"),
      accountStorageVersion: z.number().int().positive(),
      connectorAuthMode: z.literal("automatic"),
      connectorStorageVersion: z.number().int().positive(),
    }),
    customConnectorAutomaticOAuthBindingSchema,
  )
  .refine((row) => {
    return row.accountStorageVersion === row.connectorStorageVersion;
  })
  .transform((row) => {
    return customConnectorAutomaticOAuthBindingSchema.parse(row);
  });

export async function readCustomConnectorAutomaticOAuthBinding(
  db: Db,
  connectorAccountId: string,
): Promise<CustomConnectorAutomaticOAuthBinding | null> {
  const [row] = await db
    .select({
      accountAuthMethod: connectors.authMethod,
      accountStorageVersion: connectors.storageVersion,
      connectorAuthMode: orgCustomConnectors.authMode,
      connectorStorageVersion: orgCustomConnectors.storageVersion,
      connectorAccountId:
        customConnectorAccountOauthBindings.connectorAccountId,
      customConnectorId: customConnectorAccountOauthBindings.customConnectorId,
      issuer: customConnectorAccountOauthBindings.issuer,
      resource: customConnectorAccountOauthBindings.resource,
      resourceMetadataUrl:
        customConnectorAccountOauthBindings.resourceMetadataUrl,
      tokenEndpoint: customConnectorAccountOauthBindings.tokenEndpoint,
      clientId: customConnectorAccountOauthBindings.clientId,
      tokenEndpointAuthMethod:
        customConnectorAccountOauthBindings.tokenEndpointAuthMethod,
      registrationMethod:
        customConnectorAccountOauthBindings.registrationMethod,
      dcrRegistration: {
        id: orgCustomConnectorDcrRegistrations.id,
        customConnectorId: orgCustomConnectorDcrRegistrations.customConnectorId,
        issuer: orgCustomConnectorDcrRegistrations.issuer,
        clientId: orgCustomConnectorDcrRegistrations.clientId,
        tokenEndpointAuthMethod:
          orgCustomConnectorDcrRegistrations.tokenEndpointAuthMethod,
        hasClientSecret: isNotNull(
          orgCustomConnectorDcrRegistrations.encryptedClientSecret,
        ),
        encryptedClientSecret:
          orgCustomConnectorDcrRegistrations.encryptedClientSecret,
        registeredScopes: orgCustomConnectorDcrRegistrations.registeredScopes,
        redirectUri: orgCustomConnectorDcrRegistrations.redirectUri,
        issuedAt: orgCustomConnectorDcrRegistrations.issuedAt,
        expiresAt: orgCustomConnectorDcrRegistrations.expiresAt,
      },
    })
    .from(customConnectorAccountOauthBindings)
    .innerJoin(
      connectors,
      and(
        eq(
          connectors.id,
          customConnectorAccountOauthBindings.connectorAccountId,
        ),
        eq(
          connectors.customConnectorId,
          customConnectorAccountOauthBindings.customConnectorId,
        ),
      ),
    )
    .innerJoin(
      orgCustomConnectors,
      and(
        eq(
          orgCustomConnectors.id,
          customConnectorAccountOauthBindings.customConnectorId,
        ),
        eq(orgCustomConnectors.orgId, connectors.orgId),
      ),
    )
    .leftJoin(
      orgCustomConnectorDcrRegistrations,
      and(
        eq(
          orgCustomConnectorDcrRegistrations.id,
          customConnectorAccountOauthBindings.dcrRegistrationId,
        ),
        eq(
          orgCustomConnectorDcrRegistrations.customConnectorId,
          customConnectorAccountOauthBindings.customConnectorId,
        ),
      ),
    )
    .where(
      eq(
        customConnectorAccountOauthBindings.connectorAccountId,
        connectorAccountId,
      ),
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const parsed = automaticOAuthBindingPersistenceSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

export function customConnectorAutomaticOAuthErrorCode(
  error: McpAutomaticOAuthError,
): CustomConnectorAutomaticOAuthErrorCode {
  switch (error.reason) {
    case "invalid-authentication-response": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHENTICATION_RESPONSE_INVALID;
    }
    case "invalid-discovery-metadata": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.DISCOVERY_INVALID;
    }
    case "unsupported-authorization": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.AUTHORIZATION_UNSUPPORTED;
    }
    case "registration-unavailable": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_UNAVAILABLE;
    }
    case "registration-rejected": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_REJECTED;
    }
    case "invalid-registration": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_INVALID;
    }
    case "registration-conflict": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.CLIENT_REGISTRATION_CONFLICT;
    }
    case "unsafe-url": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.UNSAFE_URL;
    }
    case "temporary-upstream": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.PROVIDER_UNAVAILABLE;
    }
    case "binding-drift": {
      return CUSTOM_CONNECTOR_AUTOMATIC_OAUTH_ERROR_CODES.BINDING_CHANGED;
    }
  }
}

type PersistedDcrRegistration =
  typeof orgCustomConnectorDcrRegistrations.$inferSelect;

const readCustomDcrRegistrationByIssuer$ = command(
  async (
    { set },
    args: { readonly customConnectorId: string; readonly issuer: string },
    signal: AbortSignal,
  ): Promise<
    (PersistedDcrRegistration & { readonly hasClientSecret: boolean }) | null
  > => {
    const db = set(writeDb$);
    const [registration] = await db
      .select()
      .from(orgCustomConnectorDcrRegistrations)
      .where(
        and(
          eq(
            orgCustomConnectorDcrRegistrations.customConnectorId,
            args.customConnectorId,
          ),
          eq(orgCustomConnectorDcrRegistrations.issuer, args.issuer),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return registration
      ? {
          ...registration,
          hasClientSecret: registration.encryptedClientSecret !== null,
        }
      : null;
  },
);

const hasCustomDcrLinkedAccounts$ = command(
  async (
    { set },
    registrationId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const [account] = await db
      .select({ id: customConnectorAccountOauthBindings.connectorAccountId })
      .from(customConnectorAccountOauthBindings)
      .where(
        eq(
          customConnectorAccountOauthBindings.dcrRegistrationId,
          registrationId,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return account !== undefined;
  },
);

export function retireCustomConnectorDcrRegistrationSql(
  registrationId: string,
  updatedAt: Date,
) {
  // Consume each preceding write even when it returns no rows, preserving
  // account -> binding -> registration order and the registration's NO ACTION FK.
  return sql`WITH reconnected_accounts AS (
    UPDATE ${connectors}
    SET ${sql.identifier(connectors.needsReconnect.name)} = true,
        ${sql.identifier(connectors.reconnectReason.name)} = 'authorization_expired_or_revoked',
        ${sql.identifier(connectors.updatedAt.name)} = ${timestampWithoutTimeZone(updatedAt)}::timestamp
    WHERE ${inArray(
      connectors.id,
      sql`(SELECT ${customConnectorAccountOauthBindings.connectorAccountId}
        FROM ${customConnectorAccountOauthBindings}
        WHERE ${eq(customConnectorAccountOauthBindings.dcrRegistrationId, registrationId)})`,
    )}
    RETURNING ${connectors.id}
  ), deleted_bindings AS (
    DELETE FROM ${customConnectorAccountOauthBindings}
    WHERE ${eq(customConnectorAccountOauthBindings.dcrRegistrationId, registrationId)}
      AND (SELECT ${count()} FROM reconnected_accounts) >= 0
    RETURNING ${customConnectorAccountOauthBindings.connectorAccountId}
  )
  DELETE FROM ${orgCustomConnectorDcrRegistrations}
  WHERE ${eq(orgCustomConnectorDcrRegistrations.id, registrationId)}
    AND (SELECT ${count()} FROM deleted_bindings) >= 0`;
}

function customDcrClientStore(args: {
  readonly db: Db;
  readonly customConnectorId: string;
  readonly featureContext: FeatureSwitchContext;
}): McpAutomaticOAuthDcrClientStore {
  return {
    async readBoundClient(registrationId) {
      const [registration] = await args.db
        .select()
        .from(orgCustomConnectorDcrRegistrations)
        .where(
          and(
            eq(orgCustomConnectorDcrRegistrations.id, registrationId),
            eq(
              orgCustomConnectorDcrRegistrations.customConnectorId,
              args.customConnectorId,
            ),
          ),
        )
        .limit(1);
      if (!registration) {
        return null;
      }
      return {
        ...registration,
        hasClientSecret: registration.encryptedClientSecret !== null,
        clientSecret: registration.encryptedClientSecret
          ? await decryptStoredSecretValue(
              registration.encryptedClientSecret,
              args.featureContext,
            )
          : undefined,
      };
    },
  };
}

const retireCustomDcrRegistration$ = command(
  async ({ set }, registrationId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    await db.execute(
      retireCustomConnectorDcrRegistrationSql(registrationId, nowDate()),
    );
    signal.throwIfAborted();
  },
);

const createCustomDcrRegistration$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly customConnectorId: string;
      readonly storageVersion: number;
      readonly endpoint: string;
      readonly featureContext: FeatureSwitchContext;
      readonly registration: McpAutomaticOAuthDcrRegistrationInput;
    },
    signal: AbortSignal,
  ): Promise<McpAutomaticOAuthDcrRegistration> => {
    const db = set(writeDb$);
    const { registration } = args;
    const encryptedClientSecret = registration.clientSecret
      ? await encryptStoredSecretValue(
          registration.clientSecret,
          args.featureContext,
        )
      : null;
    signal.throwIfAborted();
    const [definition] = await db
      .select({ id: orgCustomConnectors.id })
      .from(orgCustomConnectors)
      .where(
        and(
          eq(orgCustomConnectors.id, args.customConnectorId),
          eq(orgCustomConnectors.orgId, args.orgId),
          eq(orgCustomConnectors.authMode, "automatic"),
          eq(orgCustomConnectors.storageVersion, args.storageVersion),
          eq(orgCustomConnectors.mcpEndpoint, args.endpoint),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!definition) {
      throw new Error(
        "Custom connector credential contract changed during Automatic OAuth registration",
      );
    }
    const [stored] = await db
      .insert(orgCustomConnectorDcrRegistrations)
      .values({
        orgId: args.orgId,
        customConnectorId: args.customConnectorId,
        issuer: registration.issuer,
        clientId: registration.clientId,
        encryptedClientSecret,
        tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod,
        registeredScopes: [...registration.registeredScopes],
        redirectUri: registration.redirectUri,
        issuedAt: registration.issuedAt,
        expiresAt: registration.expiresAt,
      })
      .returning();
    signal.throwIfAborted();
    if (!stored) {
      throw new Error("Failed to persist MCP OAuth dynamic registration");
    }
    return {
      ...stored,
      hasClientSecret: stored.encryptedClientSecret !== null,
    };
  },
);

export type CustomConnectorAutomaticOAuthStateContext =
  McpAutomaticOAuthContext & {
    readonly connectorId: string;
    readonly storageVersion: number;
  };

export type CustomConnectorCanonicalAutomaticOAuthStateContext =
  CustomConnectorAutomaticOAuthStateContext & {
    readonly version: 2;
    readonly authMode: "automatic";
  };

type CustomConnectorAutomaticOAuthAuthorization = Omit<
  McpAutomaticOAuthAuthorization,
  "context"
> & {
  readonly context: CustomConnectorCanonicalAutomaticOAuthStateContext;
};

export const prepareCustomConnectorAutomaticOAuthAuthorization$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly customConnectorId: string;
      readonly storageVersion: number;
      readonly endpoint: string;
      readonly redirectUri: string;
      readonly state: string;
      readonly cimdClientId: string;
      readonly dcrClientMetadata: OAuthClientMetadata;
      readonly featureContext: FeatureSwitchContext;
    },
    signal: AbortSignal,
  ): Promise<
    CustomConnectorAutomaticOAuthAuthorization | McpAutomaticNoAuth
  > => {
    const prepared = await prepareMcpAutomaticOAuthAuthorization(
      {
        ...args,
        dcrStore: {
          readByIssuer: async (issuer) => {
            return await set(
              readCustomDcrRegistrationByIssuer$,
              { customConnectorId: args.customConnectorId, issuer },
              signal,
            );
          },
          hasLinkedAccounts: async (registrationId) => {
            return await set(
              hasCustomDcrLinkedAccounts$,
              registrationId,
              signal,
            );
          },
          retire: async (registrationId) => {
            await set(retireCustomDcrRegistration$, registrationId, signal);
          },
          create: async (registration, createSignal) => {
            return await set(
              createCustomDcrRegistration$,
              { ...args, registration },
              createSignal,
            );
          },
        },
      },
      signal,
    );
    if (prepared.kind === "none") {
      return prepared;
    }
    return {
      ...prepared,
      context: {
        ...prepared.context,
        version: 2,
        authMode: "automatic",
        connectorId: args.customConnectorId,
        storageVersion: args.storageVersion,
      } satisfies CustomConnectorCanonicalAutomaticOAuthStateContext,
    };
  },
);

export async function prepareCustomConnectorAutomaticOAuthReauthorization(
  args: {
    readonly db: Db;
    readonly binding: CustomConnectorAutomaticOAuthBinding;
    readonly storageVersion: number;
    readonly endpoint: string;
    readonly redirectUri: string;
    readonly cimdClientId: string;
    readonly requestedScope: string;
    readonly state: string;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
): Promise<CustomConnectorAutomaticOAuthAuthorization> {
  const prepared = await prepareMcpAutomaticOAuthReauthorization(
    {
      ...args,
      dcrStore: customDcrClientStore({
        ...args,
        customConnectorId: args.binding.customConnectorId,
      }),
    },
    signal,
  );
  return {
    ...prepared,
    context: {
      ...prepared.context,
      version: 2,
      authMode: "automatic",
      connectorId: args.binding.customConnectorId,
      storageVersion: args.storageVersion,
    } satisfies CustomConnectorCanonicalAutomaticOAuthStateContext,
  };
}

export async function exchangeCustomConnectorAutomaticOAuthCode(
  args: {
    readonly db: Db;
    readonly context: CustomConnectorAutomaticOAuthStateContext;
    readonly redirectUri: string;
    readonly cimdClientId: string;
    readonly code: string;
    readonly iss: string | undefined;
    readonly codeVerifier: string;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
) {
  return await exchangeMcpAutomaticOAuthCode(
    {
      ...args,
      dcrStore: customDcrClientStore({
        ...args,
        customConnectorId: args.context.connectorId,
      }),
    },
    signal,
  );
}

export async function refreshCustomConnectorAutomaticOAuthToken(
  args: {
    readonly db: Db;
    readonly binding: CustomConnectorAutomaticOAuthBinding;
    readonly endpoint: string;
    readonly redirectUri: string;
    readonly cimdClientId: string;
    readonly refreshToken: string;
    readonly featureContext: FeatureSwitchContext;
  },
  signal: AbortSignal,
) {
  return await refreshMcpAutomaticOAuthToken(
    {
      ...args,
      dcrStore: customDcrClientStore({
        ...args,
        customConnectorId: args.binding.customConnectorId,
      }),
    },
    signal,
  );
}
