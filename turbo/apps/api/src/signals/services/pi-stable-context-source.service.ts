import { z } from "zod";
import { SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION } from "@okouai/connectors/connector-catalog/artifacts/artifacts";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const sourceSchema = z
  .object({
    agentGeneration: z.number().int().positive(),
    userGeneration: z.number().int().positive(),
    catalog: z
      .object({
        schemaVersion: z.literal(SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION),
        hash: digest,
        capabilityDigest: digest,
      })
      .strict()
      .nullable(),
    agentIdentityDigest: z.string().min(1),
    featurePromptDigest: z.string().min(1),
    permissionDigest: z.string().min(1),
    connectorScopeDigest: z.string().min(1),
    validityHorizon: z.string().datetime().nullable(),
    promptSchemaVersion: z.number().int().positive(),
    runtimeSchemaVersion: z.number().int().positive(),
    extractorVersion: z.number().int().positive(),
  })
  .strict();

/** Unknown historical JSON loses its binding; this never supplies an identity. */
export function hasImmutablePiCatalogSource(
  value: unknown,
  capabilityDigest: string,
): boolean {
  const parsed = sourceSchema.safeParse(value);
  return (
    parsed.success &&
    (parsed.data.catalog === null ||
      parsed.data.catalog.capabilityDigest === capabilityDigest)
  );
}
