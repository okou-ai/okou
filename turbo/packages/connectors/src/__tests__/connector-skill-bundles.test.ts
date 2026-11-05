import { describe, expect, it } from "vitest";
import {
  CONNECTOR_SKILL_BUNDLE_RECEIPT_MAX_BYTES,
  connectorSkillBundleReceiptKey,
  parseConnectorSkillBundleReceipt,
} from "../connector-catalog/artifacts/skill-bundles";

const catalogDigest = `sha256:${"a".repeat(64)}`;
const bundle = { sha256: "b".repeat(64), archiveBytes: 100 };
function source(slug: string, versionId: string, archiveSize = 100) {
  return {
    slug,
    skill: {
      kind: "bundled" as const,
      storageName: `connector-${slug}`,
      versionId,
      storageVersionPrefix: `__system__/volume/connector-${slug}/${versionId}`,
      size: 10,
      archiveSize,
      fileCount: 1,
    },
  };
}
const first = source("first", "c".repeat(64));
const second = source("second", "d".repeat(64));
const reference = {
  slug: first.slug,
  sourceVersionId: first.skill.versionId,
  bundle,
};
const other = {
  slug: second.slug,
  sourceVersionId: second.skill.versionId,
  bundle,
};
function parse(receipt: unknown, connectors = [first, second]) {
  return parseConnectorSkillBundleReceipt({
    rawBytes: Buffer.from(JSON.stringify(receipt)),
    catalogDigest,
    connectors,
  });
}
function receipt(skills: readonly unknown[]) {
  return { version: 1, catalogDigest, skills };
}

describe("catalog-bound Connector Skill bundle receipts", () => {
  it("bounds receipt input before decoding or parsing", () => {
    expect(() => {
      return parseConnectorSkillBundleReceipt({
        rawBytes: new Uint8Array(CONNECTOR_SKILL_BUNDLE_RECEIPT_MAX_BYTES + 1),
        catalogDigest,
        connectors: [first, second],
      });
    }).toThrow("byte limit");
    expect(() => {
      return connectorSkillBundleReceiptKey(first.skill.versionId);
    }).toThrow();
  });
  it("binds shared compressed bytes to each exact source without changing identity", () => {
    expect(parse(receipt([other, reference]))).toEqual([other, reference]);
    expect(connectorSkillBundleReceiptKey(catalogDigest)).toBe(
      `connectors/skill-bundles/v1/${"a".repeat(64)}.json`,
    );
  });

  it.each([
    receipt([reference]),
    receipt([reference, reference]),
    receipt([reference, { ...other, slug: "unknown" }]),
    receipt([reference, { ...other, sourceVersionId: first.skill.versionId }]),
    receipt([
      reference,
      { ...other, bundle: { ...bundle, archiveBytes: 101 } },
    ]),
    receipt([
      reference,
      { ...other, bundle: { ...bundle, sha256: "invalid" } },
    ]),
    receipt([
      reference,
      { ...other, bundle: { ...bundle, archiveBytes: "100" } },
    ]),
    receipt([reference, { ...other, bundle: { ...bundle, extra: true } }]),
    {
      ...receipt([reference, other]),
      catalogDigest: `sha256:${"e".repeat(64)}`,
    },
    { ...receipt([reference, other]), version: 2 },
    { ...receipt([reference, other]), extra: true },
  ])("rejects incomplete, conflicting or malformed receipts %#", (value) => {
    expect(() => {
      return parse(value);
    }).toThrow();
  });

  it("rejects a shared hash with conflicting compressed sizes even when sources match", () => {
    expect(() => {
      return parse(
        receipt([
          reference,
          { ...other, bundle: { ...bundle, archiveBytes: 101 } },
        ]),
        [first, source(second.slug, second.skill.versionId, 101)],
      );
    }).toThrow("source binding");
  });

  it("keeps skill:none distinct from a missing preparation", () => {
    expect(
      parseConnectorSkillBundleReceipt({
        rawBytes: Buffer.from(JSON.stringify(receipt([]))),
        catalogDigest,
        connectors: [{ slug: "mcp-only", skill: { kind: "none" } }],
      }),
    ).toEqual([]);
    expect(() => {
      return parseConnectorSkillBundleReceipt({
        rawBytes: Buffer.from(JSON.stringify(receipt([reference]))),
        catalogDigest,
        connectors: [{ slug: first.slug, skill: { kind: "none" } }],
      });
    }).toThrow("does not match catalog");
  });
});
