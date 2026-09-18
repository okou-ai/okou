import { z } from "zod";

import { connectorAuthMethodIdSchema } from "../../connector-identity";

import {
  connectorCatalogVersionSchema,
  connectorSlugSchema,
  privateNameSchema,
} from "./common";
import { ConnectorCatalogRelationshipError } from "./relationship-error";

export const publicFieldIdSchema = z.string().regex(/^[a-z][a-zA-Z0-9]*$/u);
export const internalOptionNameSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/u);
export { connectorAuthMethodIdSchema };
const connectorCategoryIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const connectorGenerationTypeSchema = z.enum([
  "audio",
  "code",
  "document",
  "image",
  "presentation",
  "text",
  "video",
  "website",
]);
export const connectorValueRefSchema = z
  .string()
  .regex(/^\$(?:secrets|vars)\.[A-Z][A-Z0-9_]*$/u);
const connectorSecretRefSchema = z
  .string()
  .regex(/^\$secrets\.[A-Z][A-Z0-9_]*$/u);

export const connectorMcpSchema = z
  .object({
    transport: z.literal("streamable-http"),
    endpoint: z
      .string()
      .url()
      .refine((value) => {
        if (!URL.canParse(value)) {
          return false;
        }
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          url.href === value &&
          !url.username &&
          !url.password &&
          !url.hash &&
          !url.search &&
          !/[{}?#]/u.test(value) &&
          /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z][a-z0-9-]*$/u.test(
            url.hostname,
          ) &&
          url.hostname.split(".").every((label) => {
            return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label);
          }) &&
          !/(?:^|\.)(?:localhost|local|internal|invalid)$/u.test(url.hostname)
        );
      }, "MCP endpoint must be a canonical fixed public HTTPS URL"),
  })
  .strict();

export const connectorReplacementSchema = z
  .object({ connectorSlug: connectorSlugSchema })
  .strict();

const connectorAutomaticTokenBindingsSchema = z
  .object({
    accessToken: connectorSecretRefSchema,
    refreshToken: connectorSecretRefSchema.optional(),
  })
  .strict();

export const noneGrantSourceSchema = z
  .object({ kind: z.literal("none") })
  .strict();
export const automaticGrantSourceSchema = z
  .object({
    kind: z.literal("automatic"),
    callbackOrigin: z.literal("api"),
    outputs: connectorAutomaticTokenBindingsSchema,
  })
  .strict();

const categoryGroupSourceSchema = z
  .object({
    id: connectorCategoryIdSchema,
    label: z.string().min(1),
    menuLabel: z.string().min(1),
  })
  .strict();

const categorySourceSchema = z
  .object({
    id: connectorCategoryIdSchema,
    label: z.string().min(1),
    menuLabel: z.string().min(1),
    groupId: connectorCategoryIdSchema.nullable(),
  })
  .strict();

export const catalogSourceSchema = z
  .object({
    catalogVersion: connectorCatalogVersionSchema,
    categoryMetadata: z
      .object({
        categories: z.array(categorySourceSchema).min(1),
        groups: z.array(categoryGroupSourceSchema),
      })
      .strict(),
  })
  .strict();

const staticConfidentialClientSourceSchema = z
  .object({
    clientRegistration: z.literal("static"),
    clientType: z.literal("confidential"),
    clientIdEnv: privateNameSchema,
    clientSecretEnv: privateNameSchema,
  })
  .strict();

const staticConfidentialLiteralClientSourceSchema = z
  .object({
    clientRegistration: z.literal("static"),
    clientType: z.literal("confidential"),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
  })
  .strict();

const staticPublicClientSourceSchema = z
  .object({
    clientRegistration: z.literal("static"),
    clientType: z.literal("public"),
    clientId: z.string().min(1),
  })
  .strict();

const dynamicPublicClientSourceSchema = z
  .object({
    clientRegistration: z.literal("dynamic"),
    clientType: z.literal("public"),
  })
  .strict();

export const connectorAuthClientSourceSchema = z.union([
  staticConfidentialClientSourceSchema,
  staticConfidentialLiteralClientSourceSchema,
  staticPublicClientSourceSchema,
  dynamicPublicClientSourceSchema,
]);

export const connectorStorageSourceSchema = z
  .object({
    version: z.number().int().positive(),
    secrets: z.array(privateNameSchema),
    variables: z.array(privateNameSchema),
  })
  .strict();

const manualGrantFieldSourceSchema = z
  .object({
    privateName: privateNameSchema,
    publicId: publicFieldIdSchema,
    label: z.string().min(1),
    required: z.boolean(),
    placeholder: z.string().min(1).optional(),
    storage: z.enum(["secret", "variable"]),
    normalize: z.literal("host").optional(),
  })
  .strict();

const deviceStartOptionChoiceSourceSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

const deviceStartOptionSourceSchema = z
  .object({
    privateName: internalOptionNameSchema,
    publicId: publicFieldIdSchema,
    kind: z.literal("select"),
    label: z.string().min(1),
    required: z.boolean(),
    defaultValue: z.string().min(1).optional(),
    options: z.array(deviceStartOptionChoiceSourceSchema).min(1),
  })
  .strict();

const outputBindingsSchema = z.record(
  z.string().min(1),
  connectorValueRefSchema,
);

const manualGrantSourceSchema = z
  .object({
    kind: z.literal("manual"),
    fields: z.array(manualGrantFieldSourceSchema).min(1),
  })
  .strict();

const authCodeGrantSourceSchema = z
  .object({
    kind: z.literal("auth-code"),
    scopes: z.array(z.string()),
    callbackOrigin: z.enum(["web", "api"]),
    outputs: outputBindingsSchema,
  })
  .strict();

const openIdGrantSourceSchema = z
  .object({
    kind: z.literal("openid-auth"),
    callbackOrigin: z.enum(["web", "api"]),
    outputs: outputBindingsSchema,
  })
  .strict();

const externalCodeGrantSourceSchema = z
  .object({
    kind: z.literal("external-code"),
    scopes: z.array(z.string()),
    outputs: outputBindingsSchema,
  })
  .strict();

const deviceAuthGrantSourceSchema = z
  .object({
    kind: z.literal("device-auth"),
    scopes: z.array(z.string()),
    outputs: outputBindingsSchema,
    startOptions: z.array(deviceStartOptionSourceSchema),
  })
  .strict();

const connectorGrantSourceSchema = z.discriminatedUnion("kind", [
  noneGrantSourceSchema,
  automaticGrantSourceSchema,
  manualGrantSourceSchema,
  authCodeGrantSourceSchema,
  openIdGrantSourceSchema,
  externalCodeGrantSourceSchema,
  deviceAuthGrantSourceSchema,
]);

const envBindingSourceSchema = z.union([
  connectorValueRefSchema,
  z
    .object({
      valueRef: connectorValueRefSchema,
      optional: z.literal(true),
    })
    .strict(),
]);

const staticAccessSourceSchema = z
  .object({
    kind: z.literal("static"),
    envBindings: z.record(z.string().min(1), envBindingSourceSchema),
    platformSecrets: z.array(privateNameSchema).optional(),
  })
  .strict();

const refreshTokenAccessSourceSchema = z
  .object({
    kind: z.literal("refresh-token"),
    envBindings: z.record(z.string().min(1), envBindingSourceSchema),
    platformSecrets: z.array(privateNameSchema).optional(),
    inputs: z.record(z.string().min(1), connectorValueRefSchema),
    outputs: z.record(z.string().min(1), connectorValueRefSchema),
    refreshableSecrets: z.array(privateNameSchema),
  })
  .strict();

export const connectorAccessSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("automatic"),
      inputs: connectorAutomaticTokenBindingsSchema,
      outputs: connectorAutomaticTokenBindingsSchema,
    })
    .strict(),
  staticAccessSourceSchema,
  refreshTokenAccessSourceSchema,
]);

const noRevokeSourceSchema = z.object({ kind: z.literal("none") }).strict();
const tokenRevokeSourceSchema = z
  .object({
    kind: z.literal("token-revoke"),
    inputs: z.record(z.string().min(1), connectorSecretRefSchema),
    revokePreviousOnReplace: z.boolean().optional(),
  })
  .strict();

export const connectorRevokeSourceSchema = z.discriminatedUnion("kind", [
  noRevokeSourceSchema,
  tokenRevokeSourceSchema,
]);

const connectorAuthMethodSourceSchema = z
  .object({
    id: connectorAuthMethodIdSchema,
    label: z.string().min(1),
    description: z.string().min(1).nullable(),
    visible: z.boolean(),
    client: connectorAuthClientSourceSchema.optional(),
    storage: connectorStorageSourceSchema,
    grant: connectorGrantSourceSchema,
    access: connectorAccessSourceSchema,
    revoke: connectorRevokeSourceSchema,
  })
  .strict();

export const connectorSourceSchema = z
  .object({
    label: z.string().min(1),
    description: z.string().min(1),
    category: connectorCategoryIdSchema,
    generation: z.array(connectorGenerationTypeSchema),
    tags: z.array(z.string().min(1)),
    mcp: connectorMcpSchema.optional(),
    replaces: connectorReplacementSchema.optional(),
    authMethods: z.array(connectorAuthMethodSourceSchema).min(1),
  })
  .strict();

type CatalogSource = z.infer<typeof catalogSourceSchema>;
type ConnectorSource = z.infer<typeof connectorSourceSchema>;
export type ConnectorAuthMethodSource = ConnectorSource["authMethods"][number];
export type ConnectorGrantSource = ConnectorAuthMethodSource["grant"];

function assertUnique(args: {
  readonly values: readonly string[];
  readonly label: string;
}): void {
  const seen = new Set<string>();
  for (const value of args.values) {
    if (seen.has(value)) {
      throw new ConnectorCatalogRelationshipError(
        "duplicate-identifier",
        `Duplicate ${args.label}: ${value}`,
      );
    }
    seen.add(value);
  }
}

function normalizePublicId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/gu, "").toLowerCase();
}

function valueRefName(valueRef: string): string {
  const separator = valueRef.indexOf(".");
  return valueRef.slice(separator + 1);
}

function authMethodValueRefs(
  authMethod: ConnectorAuthMethodSource,
): readonly string[] {
  const refs: string[] = [];
  if ("outputs" in authMethod.grant) {
    refs.push(
      ...Object.values(authMethod.grant.outputs).filter(
        (value): value is string => {
          return value !== undefined;
        },
      ),
    );
  }
  for (const binding of Object.values(
    "envBindings" in authMethod.access ? authMethod.access.envBindings : {},
  )) {
    refs.push(typeof binding === "string" ? binding : binding.valueRef);
  }
  if (
    authMethod.access.kind === "refresh-token" ||
    authMethod.access.kind === "automatic"
  ) {
    refs.push(
      ...Object.values(authMethod.access.inputs).filter(
        (value): value is string => {
          return value !== undefined;
        },
      ),
    );
    refs.push(
      ...Object.values(authMethod.access.outputs).filter(
        (value): value is string => {
          return value !== undefined;
        },
      ),
    );
  }
  if (authMethod.revoke.kind === "token-revoke") {
    refs.push(...Object.values(authMethod.revoke.inputs));
  }
  return refs;
}

interface AuthStorageSets {
  readonly secretNames: ReadonlySet<string>;
  readonly variableNames: ReadonlySet<string>;
  readonly platformSecrets: ReadonlySet<string>;
}

function authStorageSets(
  authMethod: ConnectorAuthMethodSource,
): AuthStorageSets {
  return {
    secretNames: new Set(authMethod.storage.secrets),
    variableNames: new Set(authMethod.storage.variables),
    platformSecrets: new Set(
      "platformSecrets" in authMethod.access
        ? (authMethod.access.platformSecrets ?? [])
        : [],
    ),
  };
}

function validateStorageDeclarations(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
  storage: AuthStorageSets,
): void {
  assertUnique({
    values: authMethod.storage.secrets,
    label: `${methodRef} storage secret`,
  });
  assertUnique({
    values: authMethod.storage.variables,
    label: `${methodRef} storage variable`,
  });
  for (const name of storage.secretNames) {
    if (storage.variableNames.has(name)) {
      throw new ConnectorCatalogRelationshipError(
        "overlapping-storage-classes",
        `${methodRef} declares ${name} in both storage classes`,
      );
    }
  }
  for (const name of storage.platformSecrets) {
    if (storage.secretNames.has(name) || storage.variableNames.has(name)) {
      throw new ConnectorCatalogRelationshipError(
        "platform-secret-storage-overlap",
        `${methodRef} declares platform secret ${name} in connector storage`,
      );
    }
  }
}

function validateManualGrant(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
  storage: AuthStorageSets,
): void {
  if (authMethod.grant.kind !== "manual") {
    return;
  }
  assertUnique({
    values: authMethod.grant.fields.map((field) => {
      return field.privateName;
    }),
    label: `${methodRef} manual private name`,
  });
  assertUnique({
    values: authMethod.grant.fields.map((field) => {
      return field.publicId;
    }),
    label: `${methodRef} manual public id`,
  });
  for (const field of authMethod.grant.fields) {
    const expectedNames =
      field.storage === "secret" ? storage.secretNames : storage.variableNames;
    if (!expectedNames.has(field.privateName)) {
      throw new ConnectorCatalogRelationshipError(
        "manual-field-storage",
        `${methodRef} manual field ${field.privateName} is missing from ${field.storage} storage`,
      );
    }
    const normalizedPublicId = normalizePublicId(field.publicId);
    const normalizedPrivateName = normalizePublicId(field.privateName);
    if (
      normalizedPublicId === normalizedPrivateName ||
      normalizedPublicId.includes(normalizedPrivateName)
    ) {
      throw new ConnectorCatalogRelationshipError(
        "private-derived-public-id",
        `${methodRef} public field id ${field.publicId} derives from a private name`,
      );
    }
  }
}

function validateDeviceGrant(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
): void {
  if (authMethod.grant.kind !== "device-auth") {
    return;
  }
  assertUnique({
    values: authMethod.grant.startOptions.map((option) => {
      return option.privateName;
    }),
    label: `${methodRef} start option private name`,
  });
  assertUnique({
    values: authMethod.grant.startOptions.map((option) => {
      return option.publicId;
    }),
    label: `${methodRef} start option public id`,
  });
  for (const option of authMethod.grant.startOptions) {
    assertUnique({
      values: option.options.map((choice) => {
        return choice.value;
      }),
      label: `${methodRef}/${option.publicId} option value`,
    });
    if (
      option.defaultValue !== undefined &&
      !option.options.some((choice) => {
        return choice.value === option.defaultValue;
      })
    ) {
      throw new ConnectorCatalogRelationshipError(
        "device-option-default",
        `${methodRef}/${option.publicId} defaultValue is not an option`,
      );
    }
  }
}

function validateClientGrantAlignment(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
): void {
  const grantNeedsClient = [
    "auth-code",
    "external-code",
    "device-auth",
  ].includes(authMethod.grant.kind);
  if (grantNeedsClient !== (authMethod.client !== undefined)) {
    throw new ConnectorCatalogRelationshipError(
      "auth-client-presence",
      `${methodRef} client does not match its grant kind`,
    );
  }
  if (
    authMethod.grant.kind === "auth-code" &&
    authMethod.client?.clientRegistration !== "static"
  ) {
    throw new ConnectorCatalogRelationshipError(
      "auth-code-client-registration",
      `${methodRef} auth-code grant requires a static client`,
    );
  }
  if (
    (authMethod.grant.kind === "external-code" ||
      authMethod.grant.kind === "device-auth") &&
    authMethod.client?.clientType !== "public"
  ) {
    throw new ConnectorCatalogRelationshipError(
      "auth-client-type",
      `${methodRef} grant requires a public client`,
    );
  }
}

function validateValueReferences(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
  storage: AuthStorageSets,
): void {
  for (const valueRef of authMethodValueRefs(authMethod)) {
    const name = valueRefName(valueRef);
    const known = valueRef.startsWith("$secrets.")
      ? storage.secretNames.has(name) || storage.platformSecrets.has(name)
      : storage.variableNames.has(name);
    if (!known) {
      throw new ConnectorCatalogRelationshipError(
        "undeclared-storage-reference",
        `${methodRef} references undeclared storage ${valueRef}`,
      );
    }
  }
}

function validateRefreshableSecrets(
  methodRef: string,
  authMethod: ConnectorAuthMethodSource,
  storage: AuthStorageSets,
): void {
  if (authMethod.access.kind !== "refresh-token") {
    return;
  }
  for (const name of authMethod.access.refreshableSecrets) {
    if (!storage.secretNames.has(name)) {
      throw new ConnectorCatalogRelationshipError(
        "refreshable-secret-storage",
        `${methodRef} refreshable secret ${name} is not stored`,
      );
    }
  }
}

function validateAuthMethodSemantics(args: {
  readonly connectorSlug: string;
  readonly authMethod: ConnectorAuthMethodSource;
}): void {
  const methodRef = `${args.connectorSlug}/${args.authMethod.id}`;
  const storage = authStorageSets(args.authMethod);
  validateStorageDeclarations(methodRef, args.authMethod, storage);
  validateManualGrant(methodRef, args.authMethod, storage);
  validateDeviceGrant(methodRef, args.authMethod);
  validateClientGrantAlignment(methodRef, args.authMethod);
  validateValueReferences(methodRef, args.authMethod, storage);
  validateRefreshableSecrets(methodRef, args.authMethod, storage);
}

export function validateConnectorSourceSemantics(args: {
  readonly connectorSlug: string;
  readonly source: ConnectorSource;
}): void {
  validateConnectorProtocolSemantics({
    connectorSlug: args.connectorSlug,
    ...args.source,
  });
  assertUnique({
    values: args.source.authMethods.map((authMethod) => {
      return authMethod.id;
    }),
    label: `${args.connectorSlug} auth method id`,
  });
  for (const authMethod of args.source.authMethods) {
    validateAuthMethodSemantics({
      connectorSlug: args.connectorSlug,
      authMethod,
    });
  }
}

type ConnectorProtocolAuthMethod = Pick<
  ConnectorAuthMethodSource,
  "id" | "storage" | "client" | "access" | "revoke"
> & {
  readonly grant: {
    readonly kind: string;
    readonly outputs?: Readonly<Record<string, string | undefined>>;
  };
};

function validateAutomaticTokenStorage(
  method: ConnectorProtocolAuthMethod,
): void {
  if (
    method.access.kind !== "automatic" ||
    method.grant.outputs === undefined
  ) {
    throw new ConnectorCatalogRelationshipError(
      "mcp-auth-contract",
      "Automatic token bindings are missing",
    );
  }
  const outputs = method.grant.outputs;
  for (const key of ["accessToken", "refreshToken"] as const) {
    if (
      outputs[key] !== method.access.inputs[key] ||
      outputs[key] !== method.access.outputs[key]
    ) {
      throw new ConnectorCatalogRelationshipError(
        "mcp-auth-contract",
        "Automatic grant and access bindings must match",
      );
    }
  }
  const names = Object.values(outputs)
    .filter((value): value is string => {
      return value !== undefined;
    })
    .map(valueRefName);
  if (
    new Set(names).size !== names.length ||
    method.storage.variables.length !== 0 ||
    method.storage.secrets.length !== names.length ||
    names.some((name) => {
      return !method.storage.secrets.includes(name);
    })
  ) {
    throw new ConnectorCatalogRelationshipError(
      "mcp-auth-contract",
      "Automatic storage must exactly match distinct token bindings",
    );
  }
}

/** Protocol declarations are explicit; slug suffixes have no consumer meaning. */
export function validateConnectorProtocolSemantics(args: {
  readonly connectorSlug: string;
  readonly mcp?: ConnectorSource["mcp"];
  readonly replaces?: ConnectorSource["replaces"];
  readonly authMethods: readonly ConnectorProtocolAuthMethod[];
}): void {
  if (
    args.replaces !== undefined &&
    (args.mcp === undefined ||
      args.replaces.connectorSlug === args.connectorSlug)
  ) {
    throw new ConnectorCatalogRelationshipError(
      "invalid-replacement",
      "Replacement requires an MCP connector and a distinct predecessor",
    );
  }
  for (const method of args.authMethods) {
    const generic =
      method.grant.kind === "none" || method.grant.kind === "automatic";
    if (!generic) {
      if (method.access.kind === "none" || method.access.kind === "automatic") {
        throw new ConnectorCatalogRelationshipError(
          "mcp-auth-contract",
          "MCP access does not match its grant",
        );
      }
      continue;
    }
    if (
      args.mcp === undefined ||
      method.client !== undefined ||
      method.revoke.kind !== "none" ||
      method.access.kind !== method.grant.kind
    ) {
      throw new ConnectorCatalogRelationshipError(
        "mcp-auth-contract",
        "Generic MCP authentication requires matching access and runtime-owned client and revoke",
      );
    }
    if (method.grant.kind === "none") {
      if (
        method.storage.secrets.length !== 0 ||
        method.storage.variables.length !== 0
      ) {
        throw new ConnectorCatalogRelationshipError(
          "mcp-auth-contract",
          "No-auth MCP storage must be empty",
        );
      }
      continue;
    }
    validateAutomaticTokenStorage(method);
  }
}

export function validateCatalogSourceSemantics(source: CatalogSource): void {
  const groupIds = source.categoryMetadata.groups.map((group) => {
    return group.id;
  });
  const categoryIds = source.categoryMetadata.categories.map((category) => {
    return category.id;
  });
  assertUnique({ values: groupIds, label: "catalog category group id" });
  assertUnique({ values: categoryIds, label: "catalog category id" });
  const knownGroups = new Set(groupIds);
  for (const category of source.categoryMetadata.categories) {
    if (category.groupId !== null && !knownGroups.has(category.groupId)) {
      throw new ConnectorCatalogRelationshipError(
        "unknown-category-group",
        `Catalog category ${category.id} references unknown group ${category.groupId}`,
      );
    }
  }
}
