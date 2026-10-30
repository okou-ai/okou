import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  union,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import { connectorAuthMethodIdSchema } from "../../connector-identity";

import { connectorCatalogVersionSchema, privateNameSchema } from "./common";
import { ConnectorCatalogRelationshipError } from "./relationship-error";

export const publicFieldIdSchema = string().regex(/^[a-z][a-zA-Z0-9]*$/u);
export const internalOptionNameSchema = string().regex(
  /^[a-zA-Z][a-zA-Z0-9_]*$/u,
);
export { connectorAuthMethodIdSchema };
const connectorCategoryIdSchema = string().regex(/^[a-z0-9][a-z0-9-]*$/u);
const connectorGenerationTypeSchema = zEnum([
  "audio",
  "code",
  "document",
  "image",
  "presentation",
  "text",
  "video",
  "website",
]);
export const connectorValueRefSchema = string().regex(
  /^\$(?:secrets|vars)\.[A-Z][A-Z0-9_]*$/u,
);
const connectorSecretRefSchema = string().regex(
  /^\$secrets\.[A-Z][A-Z0-9_]*$/u,
);

export const connectorMcpSchema = object({
  transport: literal("streamable-http"),
  endpoint: string()
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
}).strict();

const connectorAutomaticTokenBindingsSchema = object({
  accessToken: connectorSecretRefSchema,
  refreshToken: connectorSecretRefSchema.optional(),
}).strict();

export const noneGrantSourceSchema = object({ kind: literal("none") }).strict();
export const automaticGrantSourceSchema = object({
  kind: literal("automatic"),
  callbackOrigin: literal("api"),
  scopes: array(string()).optional(),
  authorizationPrompt: string().nullable().optional(),
  outputs: connectorAutomaticTokenBindingsSchema,
}).strict();

const categoryGroupSourceSchema = object({
  id: connectorCategoryIdSchema,
  label: string().min(1),
  menuLabel: string().min(1),
}).strict();

const categorySourceSchema = object({
  id: connectorCategoryIdSchema,
  label: string().min(1),
  menuLabel: string().min(1),
  groupId: connectorCategoryIdSchema.nullable(),
}).strict();

export const catalogSourceSchema = object({
  catalogVersion: connectorCatalogVersionSchema,
  categoryMetadata: object({
    categories: array(categorySourceSchema).min(1),
    groups: array(categoryGroupSourceSchema),
  }).strict(),
}).strict();

const staticConfidentialClientSourceSchema = object({
  clientRegistration: literal("static"),
  clientType: literal("confidential"),
  clientIdEnv: privateNameSchema,
  clientSecretEnv: privateNameSchema,
}).strict();

const staticConfidentialLiteralClientSourceSchema = object({
  clientRegistration: literal("static"),
  clientType: literal("confidential"),
  clientId: string().min(1),
  clientSecret: string().min(1),
}).strict();

const staticPublicClientSourceSchema = object({
  clientRegistration: literal("static"),
  clientType: literal("public"),
  clientId: string().min(1),
}).strict();

const dynamicPublicClientSourceSchema = object({
  clientRegistration: literal("dynamic"),
  clientType: literal("public"),
}).strict();

export const connectorAuthClientSourceSchema = union([
  staticConfidentialClientSourceSchema,
  staticConfidentialLiteralClientSourceSchema,
  staticPublicClientSourceSchema,
  dynamicPublicClientSourceSchema,
]);

export const connectorStorageSourceSchema = object({
  version: number().int().positive(),
  secrets: array(privateNameSchema),
  variables: array(privateNameSchema),
}).strict();

const manualGrantFieldSourceSchema = object({
  privateName: privateNameSchema,
  publicId: publicFieldIdSchema,
  label: string().min(1),
  required: boolean(),
  placeholder: string().min(1).optional(),
  storage: zEnum(["secret", "variable"]),
  normalize: literal("host").optional(),
}).strict();

const deviceStartOptionChoiceSourceSchema = object({
  value: string().min(1),
  label: string().min(1),
}).strict();

const deviceStartOptionSourceSchema = object({
  privateName: internalOptionNameSchema,
  publicId: publicFieldIdSchema,
  kind: literal("select"),
  label: string().min(1),
  required: boolean(),
  defaultValue: string().min(1).optional(),
  options: array(deviceStartOptionChoiceSourceSchema).min(1),
}).strict();

const outputBindingsSchema = record(string().min(1), connectorValueRefSchema);

const manualGrantSourceSchema = object({
  kind: literal("manual"),
  fields: array(manualGrantFieldSourceSchema).min(1),
}).strict();

const authCodeGrantSourceSchema = object({
  kind: literal("auth-code"),
  scopes: array(string()),
  callbackOrigin: zEnum(["web", "api"]),
  outputs: outputBindingsSchema,
}).strict();

const openIdGrantSourceSchema = object({
  kind: literal("openid-auth"),
  callbackOrigin: zEnum(["web", "api"]),
  outputs: outputBindingsSchema,
}).strict();

const externalCodeGrantSourceSchema = object({
  kind: literal("external-code"),
  scopes: array(string()),
  outputs: outputBindingsSchema,
}).strict();

const deviceAuthGrantSourceSchema = object({
  kind: literal("device-auth"),
  scopes: array(string()),
  outputs: outputBindingsSchema,
  startOptions: array(deviceStartOptionSourceSchema),
}).strict();

const connectorGrantSourceSchema = discriminatedUnion("kind", [
  noneGrantSourceSchema,
  automaticGrantSourceSchema,
  manualGrantSourceSchema,
  authCodeGrantSourceSchema,
  openIdGrantSourceSchema,
  externalCodeGrantSourceSchema,
  deviceAuthGrantSourceSchema,
]);

const envBindingSourceSchema = union([
  connectorValueRefSchema,
  object({
    valueRef: connectorValueRefSchema,
    optional: literal(true),
  }).strict(),
]);

const staticAccessSourceSchema = object({
  kind: literal("static"),
  envBindings: record(string().min(1), envBindingSourceSchema),
  platformSecrets: array(privateNameSchema).optional(),
}).strict();

const refreshTokenAccessSourceSchema = object({
  kind: literal("refresh-token"),
  envBindings: record(string().min(1), envBindingSourceSchema),
  platformSecrets: array(privateNameSchema).optional(),
  inputs: record(string().min(1), connectorValueRefSchema),
  outputs: record(string().min(1), connectorValueRefSchema),
  refreshableSecrets: array(privateNameSchema),
}).strict();

export const connectorAccessSourceSchema = discriminatedUnion("kind", [
  object({ kind: literal("none") }).strict(),
  object({
    kind: literal("automatic"),
    inputs: connectorAutomaticTokenBindingsSchema,
    outputs: connectorAutomaticTokenBindingsSchema,
  }).strict(),
  staticAccessSourceSchema,
  refreshTokenAccessSourceSchema,
]);

const noRevokeSourceSchema = object({ kind: literal("none") }).strict();
const tokenRevokeSourceSchema = object({
  kind: literal("token-revoke"),
  inputs: record(string().min(1), connectorSecretRefSchema),
  revokePreviousOnReplace: boolean().optional(),
}).strict();

export const connectorRevokeSourceSchema = discriminatedUnion("kind", [
  noRevokeSourceSchema,
  tokenRevokeSourceSchema,
]);

const connectorAuthMethodSourceSchema = object({
  id: connectorAuthMethodIdSchema,
  label: string().min(1),
  description: string().min(1).nullable(),
  visible: boolean(),
  client: connectorAuthClientSourceSchema.optional(),
  storage: connectorStorageSourceSchema,
  grant: connectorGrantSourceSchema,
  access: connectorAccessSourceSchema,
  revoke: connectorRevokeSourceSchema,
}).strict();

export const connectorSourceSchema = object({
  label: string().min(1),
  description: string().min(1),
  category: connectorCategoryIdSchema,
  generation: array(connectorGenerationTypeSchema),
  tags: array(string().min(1)),
  mcp: connectorMcpSchema.optional(),
  authMethods: array(connectorAuthMethodSourceSchema).min(1),
}).strict();

type CatalogSource = zInfer<typeof catalogSourceSchema>;
type ConnectorSource = zInfer<typeof connectorSourceSchema>;
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
  validateConnectorProtocolSemantics(args.source);
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
  readonly mcp?: ConnectorSource["mcp"];
  readonly authMethods: readonly ConnectorProtocolAuthMethod[];
}): void {
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
