import { readFileSync } from "node:fs";

import {
  AWS_SEMANTIC_MANIFEST_MAX_BYTES,
  AWS_SEMANTIC_RELEASE_MAX_SHARD_BYTES,
  AwsSemanticSidecarValidationError,
  awsSemanticArtifactDigest,
  awsSemanticManifestSchema,
  awsSemanticServiceShardSchema,
  decodeAwsSemanticManifest,
  decodeAwsSemanticServiceShard,
  encodeAwsSemanticManifest,
  encodeAwsSemanticServiceShard,
  type AwsSemanticManifest,
  type AwsSemanticService,
  type AwsSemanticServiceShard,
  type AwsSemanticShardReference,
} from "../connector-catalog/aws-semantic-sidecar";
import { connectorCatalogArtifactSchema } from "../connector-catalog/artifacts/artifacts";

const FIXTURE_DIRECTORY = new URL(
  "./fixtures/aws-semantic-sidecar-v1/",
  import.meta.url,
);
const SOURCE_SHA = "a".repeat(40);
const CATALOG_VERSION = "test-v1";

function fixtureBytes(name: string): Buffer {
  return readFileSync(new URL(name, FIXTURE_DIRECTORY));
}

function fixtureJson<T>(name: string): T {
  return JSON.parse(fixtureBytes(name).toString("utf8")) as T;
}

function manifestFixture(): AwsSemanticManifest {
  return awsSemanticManifestSchema.parse(fixtureJson("manifest.json"));
}

function shardFixture(service: AwsSemanticService): AwsSemanticServiceShard {
  return awsSemanticServiceShardSchema.parse(fixtureJson(`${service}.json`));
}

function expectValidationFailure(
  operation: () => unknown,
  code: AwsSemanticSidecarValidationError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AwsSemanticSidecarValidationError);
    expect((error as AwsSemanticSidecarValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected AWS semantic validation failure: ${code}`);
}

describe("AWS semantic sidecar contract", () => {
  it("round-trips the canonical manifest and three portable service fixtures", () => {
    const manifestBytes = fixtureBytes("manifest.json");
    const manifest = decodeAwsSemanticManifest({
      bytes: manifestBytes,
      identity: {
        sourceSha: SOURCE_SHA,
        connectorCatalogVersion: CATALOG_VERSION,
        digest: awsSemanticArtifactDigest(manifestBytes),
      },
    });
    expect(encodeAwsSemanticManifest(manifest)).toEqual(manifestBytes);
    expect(
      manifest.shards.map((reference) => {
        return reference.service;
      }),
    ).toEqual(["ec2", "iam", "s3"]);

    for (const reference of manifest.shards) {
      const bytes = fixtureBytes(`${reference.service}.json`);
      const shard = decodeAwsSemanticServiceShard({ bytes, reference });
      expect(shard.service).toBe(reference.service);
      expect(encodeAwsSemanticServiceShard(shard)).toEqual(bytes);
    }
  });

  it("keeps the strict v4 connector catalog contract isolated", () => {
    const catalog = fixtureJson<Record<string, unknown>>(
      "../published-v4-catalog.json",
    );
    expect(connectorCatalogArtifactSchema.safeParse(catalog).success).toBe(
      true,
    );
    expect(
      connectorCatalogArtifactSchema.safeParse({
        ...catalog,
        awsSemanticManifest: manifestFixture(),
      }).success,
    ).toBe(false);
  });

  it("binds manifest and shard bytes to identity, length, digest, and service", () => {
    const manifestBytes = fixtureBytes("manifest.json");
    const manifestDigest = awsSemanticArtifactDigest(manifestBytes);
    for (const identity of [
      {
        sourceSha: "b".repeat(40),
        connectorCatalogVersion: CATALOG_VERSION,
        digest: manifestDigest,
      },
      {
        sourceSha: SOURCE_SHA,
        connectorCatalogVersion: "another-release",
        digest: manifestDigest,
      },
    ]) {
      expectValidationFailure(() => {
        return decodeAwsSemanticManifest({ bytes: manifestBytes, identity });
      }, "invalid-reference");
    }
    expectValidationFailure(() => {
      return decodeAwsSemanticManifest({
        bytes: manifestBytes,
        identity: {
          sourceSha: SOURCE_SHA,
          connectorCatalogVersion: CATALOG_VERSION,
          digest: `sha256:${"0".repeat(64)}`,
        },
      });
    }, "digest-mismatch");

    const reference = manifestFixture().shards[0]!;
    const shardBytes = fixtureBytes(`${reference.service}.json`);
    for (const changedReference of [
      { ...reference, byteLength: reference.byteLength + 1 },
      { ...reference, service: "iam" as const },
    ]) {
      expectValidationFailure(() => {
        return decodeAwsSemanticServiceShard({
          bytes: shardBytes,
          reference: changedReference,
        });
      }, "invalid-reference");
    }
  });

  it("rejects unsupported, malformed, oversized, and noncanonical bytes", () => {
    const manifest = manifestFixture();
    const unsupported = Buffer.from(
      `${JSON.stringify({ ...manifest, artifactSchemaVersion: 2 })}\n`,
    );
    expectValidationFailure(() => {
      return decodeAwsSemanticManifest({
        bytes: unsupported,
        identity: {
          sourceSha: SOURCE_SHA,
          connectorCatalogVersion: CATALOG_VERSION,
          digest: awsSemanticArtifactDigest(unsupported),
        },
      });
    }, "unsupported-schema");

    const invalidJson = Buffer.from("{\n");
    expectValidationFailure(() => {
      return decodeAwsSemanticManifest({
        bytes: invalidJson,
        identity: {
          sourceSha: SOURCE_SHA,
          connectorCatalogVersion: CATALOG_VERSION,
          digest: awsSemanticArtifactDigest(invalidJson),
        },
      });
    }, "invalid-json");

    const noncanonical = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    expectValidationFailure(() => {
      return decodeAwsSemanticManifest({
        bytes: noncanonical,
        identity: {
          sourceSha: SOURCE_SHA,
          connectorCatalogVersion: CATALOG_VERSION,
          digest: awsSemanticArtifactDigest(noncanonical),
        },
      });
    }, "noncanonical-artifact");

    const oversized = Buffer.alloc(AWS_SEMANTIC_MANIFEST_MAX_BYTES + 1, 0x20);
    expectValidationFailure(() => {
      return decodeAwsSemanticManifest({
        bytes: oversized,
        identity: {
          sourceSha: SOURCE_SHA,
          connectorCatalogVersion: CATALOG_VERSION,
          digest: awsSemanticArtifactDigest(oversized),
        },
      });
    }, "object-too-large");
  });

  it("rejects noncanonical manifest references and combined size overflow", () => {
    const manifest = manifestFixture();
    expect(() => {
      return encodeAwsSemanticManifest({
        ...manifest,
        shards: [...manifest.shards].reverse(),
      });
    }).toThrow("invalid-artifact");
    expect(() => {
      return encodeAwsSemanticManifest({
        ...manifest,
        shards: manifest.shards.map((reference) => {
          return {
            ...reference,
            byteLength: Math.floor(AWS_SEMANTIC_RELEASE_MAX_SHARD_BYTES / 2),
          };
        }),
      });
    }).toThrow("invalid-artifact");
    expect(() => {
      return encodeAwsSemanticManifest({
        ...manifest,
        shards: [
          {
            ...manifest.shards[0],
            key: "connectors/aws-semantic/v1/shards/not-the-digest.json",
          },
        ],
      });
    }).toThrow("invalid-artifact");
  });

  it("rejects incomplete or misleading permission relationships", () => {
    const shard = shardFixture("ec2");
    const operation = shard.operations[0]!;
    const permission = shard.permissions[0]!;
    for (const invalidShard of [
      {
        ...shard,
        permissions: [
          { ...permission, category: "write", defaultPolicy: "allow" },
        ],
      },
      {
        ...shard,
        operations: [
          {
            ...operation,
            primaryPermission: "ec2:RunInstances",
          },
        ],
      },
      {
        ...shard,
        operations: [
          {
            ...operation,
            authorizedEffects: ["iam:PassRole", "ec2:DescribeInstances"],
          },
        ],
      },
      {
        ...shard,
        permissions: [
          ...shard.permissions,
          {
            category: "write",
            defaultPolicy: "ask",
            description: "Run EC2 instances.",
            name: "ec2:RunInstances",
          },
        ],
      },
    ]) {
      expect(() => {
        return encodeAwsSemanticServiceShard(invalidShard);
      }).toThrow("invalid-artifact");
    }
  });

  it("rejects selectors that violate service semantics or canonical predicates", () => {
    const ec2 = shardFixture("ec2");
    const ec2Operation = ec2.operations[0]!;
    expect(() => {
      return encodeAwsSemanticServiceShard({
        ...ec2,
        operations: [
          {
            ...ec2Operation,
            selectors: [{ action: "RunInstances", kind: "query-action" }],
          },
        ],
      });
    }).toThrow("invalid-artifact");

    const s3 = shardFixture("s3");
    const s3Operation = s3.operations[0]!;
    const selector = s3Operation.selectors[0]!;
    expect(selector.kind).toBe("s3-rest-xml");
    if (selector.kind !== "s3-rest-xml") {
      throw new Error("Expected S3 selector fixture");
    }
    expect(() => {
      return encodeAwsSemanticServiceShard({
        ...s3,
        operations: [
          {
            ...s3Operation,
            selectors: [
              {
                ...selector,
                requiredQuery: [
                  { name: "versionId", match: { kind: "present" } },
                ],
              },
            ],
          },
        ],
      });
    }).not.toThrow();
    for (const invalidSelector of [
      {
        ...selector,
        requiredQuery: [
          { name: "versionid", match: { kind: "present" } },
          { name: "acl", match: { kind: "present" } },
        ],
      },
      {
        ...selector,
        requiredQuery: [{ name: "acl", match: { kind: "present" } }],
        excludedQueryNames: ["acl"],
      },
    ]) {
      expect(() => {
        return encodeAwsSemanticServiceShard({
          ...s3,
          operations: [{ ...s3Operation, selectors: [invalidSelector] }],
        });
      }).toThrow("invalid-artifact");
    }
  });

  it("rejects a valid shard under a mismatched manifest key", () => {
    const reference = manifestFixture().shards[0]!;
    const mismatchedReference = {
      ...reference,
      digest: `sha256:${"f".repeat(64)}`,
    } as AwsSemanticShardReference;
    expectValidationFailure(() => {
      return decodeAwsSemanticServiceShard({
        bytes: fixtureBytes("ec2.json"),
        reference: mismatchedReference,
      });
    }, "invalid-artifact");
  });
});
