import {
  array,
  boolean,
  discriminatedUnion,
  literal,
  number,
  object,
  record,
  string,
  enum as zEnum,
  type infer as zInfer,
} from "zod";

import {
  artifactKeySchema,
  connectorCatalogVersionSchema,
  connectorSlugSchema,
  privateNameSchema,
} from "./common";
import {
  firewallCategoriesSchema,
  firewallConfigSchema,
  firewallPolicyValueSchema,
} from "./firewall";
import {
  catalogSourceSchema,
  connectorAccessSourceSchema,
  connectorAuthClientSourceSchema,
  connectorAuthMethodIdSchema,
  connectorRevokeSourceSchema,
  connectorStorageSourceSchema,
  connectorValueRefSchema,
  internalOptionNameSchema,
  publicFieldIdSchema,
  noneGrantSourceSchema,
  automaticGrantSourceSchema,
  connectorMcpSchema,
  validateConnectorProtocolSemantics,
} from "./source";
import { isConnectorCatalogIconKey } from "./icon";

export const SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION = 4;
export const CONNECTOR_CATALOG_ACTIVE_KEY = `connectors/v${SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION}/active.json`;

const CONNECTOR_SKILL_MAX_FILES = 64;
const CONNECTOR_SKILL_MAX_TOTAL_BYTES = 1024 * 1024;
const CONNECTOR_SKILL_MAX_ARCHIVE_BYTES = CONNECTOR_SKILL_MAX_TOTAL_BYTES * 2;
const CONNECTOR_SKILL_STORAGE_PATH_PREFIX = "__system__/volume";

const connectorCatalogIconSchema = object({
  key: string().refine(
    isConnectorCatalogIconKey,
    "Connector icon key must be a safe supported static asset path",
  ),
  invertInDarkMode: boolean(),
  scale: number().min(1).max(3).optional(),
}).strict();

const outputBindingsSchema = record(string().min(1), connectorValueRefSchema);

const connectorCatalogManualGrantFieldSchema = object({
  privateName: privateNameSchema,
  publicId: publicFieldIdSchema,
  label: string().min(1),
  required: boolean(),
  placeholder: string().min(1).nullable(),
  storage: zEnum(["secret", "variable"]),
  normalize: literal("host").optional(),
}).strict();

const connectorCatalogDeviceStartOptionSchema = object({
  privateName: internalOptionNameSchema,
  publicId: publicFieldIdSchema,
  kind: literal("select"),
  label: string().min(1),
  required: boolean(),
  defaultValue: string().min(1).nullable(),
  options: array(
    object({
      value: string().min(1),
      label: string().min(1),
    }).strict(),
  ).min(1),
}).strict();

const connectorCatalogGrantSchema = discriminatedUnion("kind", [
  noneGrantSourceSchema,
  automaticGrantSourceSchema,
  object({
    kind: literal("manual"),
    fields: array(connectorCatalogManualGrantFieldSchema).min(1),
  }).strict(),
  object({
    kind: literal("auth-code"),
    scopes: array(string()),
    callbackOrigin: zEnum(["web", "api"]),
    outputs: outputBindingsSchema,
  }).strict(),
  object({
    kind: literal("openid-auth"),
    callbackOrigin: zEnum(["web", "api"]),
    outputs: outputBindingsSchema,
  }).strict(),
  object({
    kind: literal("external-code"),
    scopes: array(string()),
    outputs: outputBindingsSchema,
  }).strict(),
  object({
    kind: literal("device-auth"),
    scopes: array(string()),
    outputs: outputBindingsSchema,
    startOptions: array(connectorCatalogDeviceStartOptionSchema),
  }).strict(),
]);

export const connectorCatalogAuthMethodSchema = object({
  id: connectorAuthMethodIdSchema,
  label: string().min(1),
  description: string().min(1).nullable(),
  visible: boolean(),
  client: connectorAuthClientSourceSchema.optional(),
  storage: connectorStorageSourceSchema,
  grant: connectorCatalogGrantSchema,
  access: connectorAccessSourceSchema,
  revoke: connectorRevokeSourceSchema,
}).strict();

const connectorSkillStorageNameSchema = string()
  .max(256)
  .regex(/^connector-skill@[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const connectorSkillVersionIdSchema = string().regex(/^[a-f0-9]{64}$/u);

export const connectorCatalogSkillSchema = discriminatedUnion("kind", [
  object({ kind: literal("none") }).strict(),
  object({
    kind: literal("bundled"),
    storageName: connectorSkillStorageNameSchema,
    versionId: connectorSkillVersionIdSchema,
    storageVersionPrefix: artifactKeySchema,
    size: number().int().nonnegative().max(CONNECTOR_SKILL_MAX_TOTAL_BYTES),
    archiveSize: number()
      .int()
      .positive()
      .max(CONNECTOR_SKILL_MAX_ARCHIVE_BYTES),
    fileCount: number().int().positive().max(CONNECTOR_SKILL_MAX_FILES),
  }).strict(),
]);

const connectorCatalogFirewallConfigSchema = firewallConfigSchema
  .omit({ name: true })
  .strict();

const connectorCatalogFirewallSchema = discriminatedUnion("kind", [
  object({ kind: literal("none") }).strict(),
  object({
    kind: literal("generated"),
    billable: boolean(),
    config: connectorCatalogFirewallConfigSchema,
    categories: firewallCategoriesSchema.nullable(),
    defaultAllowed: array(string().min(1)).nullable(),
    defaultUnknownPolicy: firewallPolicyValueSchema,
  }).strict(),
]);

export const connectorCatalogArtifactConnectorSchema = object({
  slug: connectorSlugSchema,
  label: string().min(1),
  description: string().min(1),
  category: string().min(1),
  generation: array(string().min(1)),
  tags: array(string().min(1)),
  mcp: connectorMcpSchema.optional(),
  authMethods: array(connectorCatalogAuthMethodSchema).min(1),
  icon: connectorCatalogIconSchema,
  skill: connectorCatalogSkillSchema,
  firewall: connectorCatalogFirewallSchema,
})
  .strict()
  .superRefine((connector, context) => {
    try {
      validateConnectorProtocolSemantics(connector);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid MCP authentication contract",
      });
    }
    if (connector.mcp !== undefined && connector.skill.kind !== "none") {
      context.addIssue({
        code: "custom",
        message: "MCP connectors must declare skill: none",
        path: ["skill"],
      });
    }
    const methodIds = connector.authMethods.map((method) => {
      return method.id;
    });
    const duplicates = methodIds.filter((methodId, index) => {
      return methodIds.indexOf(methodId) !== index;
    });
    for (const methodId of new Set(duplicates)) {
      context.addIssue({
        code: "custom",
        message: `Connector auth method IDs must be unique: ${methodId}`,
        path: ["authMethods"],
      });
    }
    if (connector.skill.kind === "none") {
      return;
    }
    const expectedStorageVersionPrefix =
      `${CONNECTOR_SKILL_STORAGE_PATH_PREFIX}/` +
      `${connector.skill.storageName}/${connector.skill.versionId}`;
    if (connector.skill.storageVersionPrefix !== expectedStorageVersionPrefix) {
      context.addIssue({
        code: "custom",
        message:
          "Connector skill storage version prefix must match its storage name and version",
        path: ["skill", "storageVersionPrefix"],
      });
    }
  });

export const connectorCatalogArtifactSchema = object({
  artifactSchemaVersion: literal(SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION),
  catalogVersion: connectorCatalogVersionSchema,
  categoryMetadata: catalogSourceSchema.shape.categoryMetadata,
  connectors: array(connectorCatalogArtifactConnectorSchema).min(1),
})
  .strict()
  .superRefine((artifact, context) => {
    const slugs = new Set(
      artifact.connectors.map((connector) => {
        return connector.slug;
      }),
    );
    if (slugs.size !== artifact.connectors.length) {
      context.addIssue({
        code: "custom",
        message: "Connector catalog slugs must be unique",
        path: ["connectors"],
      });
    }
  });

export type ConnectorCatalogArtifact = zInfer<
  typeof connectorCatalogArtifactSchema
>;
export type ConnectorCatalogArtifactConnector = zInfer<
  typeof connectorCatalogArtifactConnectorSchema
>;
export type ConnectorCatalogAuthMethod = zInfer<
  typeof connectorCatalogAuthMethodSchema
>;
export type ConnectorCatalogSkill = zInfer<typeof connectorCatalogSkillSchema>;
