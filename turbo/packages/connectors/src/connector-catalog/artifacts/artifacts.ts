import { z } from "zod";

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
  automaticGrantSourceSchema,
  noneGrantSourceSchema,
  catalogSourceSchema,
  connectorAccessSourceSchema,
  connectorAuthClientSourceSchema,
  connectorAuthMethodIdSchema,
  connectorRevokeSourceSchema,
  connectorStorageSourceSchema,
  connectorValueRefSchema,
  internalOptionNameSchema,
  publicFieldIdSchema,
} from "./source";
import { isConnectorCatalogIconKey } from "./icon";
import { connectorMcpSchema } from "./mcp";

export const SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION = 3;
export const CONNECTOR_CATALOG_ACTIVE_KEY = `connectors/v${SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION}/active.json`;

const CONNECTOR_SKILL_MAX_FILES = 64;
const CONNECTOR_SKILL_MAX_TOTAL_BYTES = 1024 * 1024;
const CONNECTOR_SKILL_MAX_ARCHIVE_BYTES = CONNECTOR_SKILL_MAX_TOTAL_BYTES * 2;
const CONNECTOR_SKILL_STORAGE_PATH_PREFIX = "__system__/volume";

function artifactHeaderShape() {
  return {
    artifactSchemaVersion: z.literal(
      SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    ),
    catalogVersion: connectorCatalogVersionSchema,
  };
}

const connectorCatalogIconSchema = z
  .object({
    key: z
      .string()
      .refine(
        isConnectorCatalogIconKey,
        "Connector icon key must be a safe supported static asset path",
      ),
    invertInDarkMode: z.boolean(),
    scale: z.number().min(1).max(3).optional(),
  })
  .strict();

const outputBindingsSchema = z.record(
  z.string().min(1),
  connectorValueRefSchema,
);

const connectorCatalogManualGrantFieldSchema = z
  .object({
    privateName: privateNameSchema,
    publicId: publicFieldIdSchema,
    label: z.string().min(1),
    required: z.boolean(),
    placeholder: z.string().min(1).nullable(),
    storage: z.enum(["secret", "variable"]),
    normalize: z.literal("host").optional(),
  })
  .strict();

const connectorCatalogDeviceStartOptionSchema = z
  .object({
    privateName: internalOptionNameSchema,
    publicId: publicFieldIdSchema,
    kind: z.literal("select"),
    label: z.string().min(1),
    required: z.boolean(),
    defaultValue: z.string().min(1).nullable(),
    options: z
      .array(
        z
          .object({
            value: z.string().min(1),
            label: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const connectorCatalogGrantSchema = z.discriminatedUnion("kind", [
  noneGrantSourceSchema,
  automaticGrantSourceSchema,
  z
    .object({
      kind: z.literal("manual"),
      fields: z.array(connectorCatalogManualGrantFieldSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("auth-code"),
      scopes: z.array(z.string()),
      callbackOrigin: z.enum(["web", "api"]),
      outputs: outputBindingsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("openid-auth"),
      callbackOrigin: z.enum(["web", "api"]),
      outputs: outputBindingsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external-code"),
      scopes: z.array(z.string()),
      outputs: outputBindingsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("device-auth"),
      scopes: z.array(z.string()),
      outputs: outputBindingsSchema,
      startOptions: z.array(connectorCatalogDeviceStartOptionSchema),
    })
    .strict(),
]);

export const connectorCatalogAuthMethodSchema = z
  .object({
    id: connectorAuthMethodIdSchema,
    label: z.string().min(1),
    description: z.string().min(1).nullable(),
    visible: z.boolean(),
    client: connectorAuthClientSourceSchema.optional(),
    storage: connectorStorageSourceSchema,
    grant: connectorCatalogGrantSchema,
    access: connectorAccessSourceSchema,
    revoke: connectorRevokeSourceSchema,
  })
  .strict();

const connectorSkillStorageNameSchema = z
  .string()
  .max(256)
  .regex(/^connector-skill@[a-z0-9]+(?:-[a-z0-9]+)*$/u);

const connectorSkillVersionIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const connectorCatalogSkillSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("bundled"),
      storageName: connectorSkillStorageNameSchema,
      versionId: connectorSkillVersionIdSchema,
      storageVersionPrefix: artifactKeySchema,
      size: z.number().int().nonnegative().max(CONNECTOR_SKILL_MAX_TOTAL_BYTES),
      archiveSize: z
        .number()
        .int()
        .positive()
        .max(CONNECTOR_SKILL_MAX_ARCHIVE_BYTES),
      fileCount: z.number().int().positive().max(CONNECTOR_SKILL_MAX_FILES),
    })
    .strict(),
]);

const connectorCatalogFirewallConfigSchema = firewallConfigSchema
  .omit({ name: true })
  .strict();

const connectorCatalogFirewallSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z
    .object({
      kind: z.literal("generated"),
      billable: z.boolean(),
      config: connectorCatalogFirewallConfigSchema,
      categories: firewallCategoriesSchema.nullable(),
      defaultAllowed: z.array(z.string().min(1)).nullable(),
      defaultUnknownPolicy: firewallPolicyValueSchema,
    })
    .strict(),
]);

export const connectorCatalogArtifactConnectorSchema = z
  .object({
    mcp: connectorMcpSchema.optional(),
    slug: connectorSlugSchema,
    label: z.string().min(1),
    description: z.string().min(1),
    category: z.string().min(1),
    generation: z.array(z.string().min(1)),
    tags: z.array(z.string().min(1)),
    authMethods: z.array(connectorCatalogAuthMethodSchema).min(1),
    icon: connectorCatalogIconSchema,
    skill: connectorCatalogSkillSchema,
    firewall: connectorCatalogFirewallSchema,
  })
  .strict()
  .superRefine((connector, context) => {
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

export const connectorCatalogArtifactSchema = z
  .object({
    ...artifactHeaderShape(),
    categoryMetadata: catalogSourceSchema.shape.categoryMetadata,
    connectors: z.array(connectorCatalogArtifactConnectorSchema).min(1),
  })
  .strict()
  .superRefine((artifact, context) => {
    const connectorSlugs = artifact.connectors.map((connector) => {
      return connector.slug;
    });
    const duplicates = connectorSlugs.filter((connectorSlug, index) => {
      return connectorSlugs.indexOf(connectorSlug) !== index;
    });
    for (const connectorSlug of new Set(duplicates)) {
      context.addIssue({
        code: "custom",
        message: `Connector catalog slugs must be unique: ${connectorSlug}`,
        path: ["connectors"],
      });
    }
  });

export type ConnectorCatalogArtifact = z.infer<
  typeof connectorCatalogArtifactSchema
>;
export type ConnectorCatalogArtifactConnector = z.infer<
  typeof connectorCatalogArtifactConnectorSchema
>;
export type ConnectorCatalogAuthMethod = z.infer<
  typeof connectorCatalogAuthMethodSchema
>;
export type ConnectorCatalogSkill = z.infer<typeof connectorCatalogSkillSchema>;
