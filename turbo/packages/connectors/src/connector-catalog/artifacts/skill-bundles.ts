import { array, literal, number, object, string } from "zod";
import type { ConnectorCatalogArtifactConnector } from "./artifacts";
import { connectorSlugSchema } from "./common";
import { CONNECTOR_CATALOG_MAX_RAW_BYTES } from "../contracts";

export const CONNECTOR_SKILL_BUNDLE_RECEIPT_MAX_BYTES =
  CONNECTOR_CATALOG_MAX_RAW_BYTES;
const digestSchema = string().regex(/^sha256:[a-f0-9]{64}$/u);
const receiptSchema = object({
  version: literal(1),
  catalogDigest: digestSchema,
  skills: array(
    object({
      slug: connectorSlugSchema,
      sourceVersionId: string().regex(/^[a-f0-9]{64}$/u),
      bundle: object({
        sha256: string().regex(/^[a-f0-9]{64}$/u),
        archiveBytes: number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
      }).strict(),
    }).strict(),
  ),
}).strict();

export function connectorSkillBundleReceiptKey(catalogDigest: string): string {
  return `connectors/skill-bundles/v1/${digestSchema.parse(catalogDigest).slice(7)}.json`;
}

/** The producer attests to original compressed bytes before publishing this receipt. */
export function parseConnectorSkillBundleReceipt(args: {
  readonly rawBytes: Uint8Array;
  readonly catalogDigest: string;
  readonly connectors: readonly Pick<
    ConnectorCatalogArtifactConnector,
    "slug" | "skill"
  >[];
}) {
  if (args.rawBytes.byteLength > CONNECTOR_SKILL_BUNDLE_RECEIPT_MAX_BYTES)
    throw new Error("Connector Skill bundle receipt exceeds byte limit");
  const value: unknown = JSON.parse(new TextDecoder().decode(args.rawBytes));
  const receipt = receiptSchema.parse(value);
  const expected = new Map(
    args.connectors.flatMap((connector) => {
      return connector.skill.kind === "bundled"
        ? [[connector.slug, connector.skill] as const]
        : [];
    }),
  );
  if (
    receipt.catalogDigest !== args.catalogDigest ||
    receipt.skills.length !== expected.size
  )
    throw new Error("Connector Skill bundle receipt does not match catalog");
  const seen = new Set<string>();
  const sizes = new Map<string, number>();
  for (const entry of receipt.skills) {
    const source = expected.get(entry.slug);
    const size = sizes.get(entry.bundle.sha256);
    if (
      seen.has(entry.slug) ||
      source === undefined ||
      source.versionId !== entry.sourceVersionId ||
      source.archiveSize !== entry.bundle.archiveBytes ||
      (size !== undefined && size !== entry.bundle.archiveBytes)
    )
      throw new Error("Connector Skill bundle source binding does not match");
    seen.add(entry.slug);
    sizes.set(entry.bundle.sha256, entry.bundle.archiveBytes);
  }
  return receipt.skills;
}
