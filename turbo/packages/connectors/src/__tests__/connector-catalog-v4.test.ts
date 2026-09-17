import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  connectorCatalogV4ArtifactSchema,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
  type ConnectorCatalogGeneration,
} from "../connector-catalog/artifacts/artifacts";
import {
  decodeAttestedConnectorCatalogSnapshot,
  decodeConnectorCatalogSnapshot,
  encodeConnectorCatalogSnapshot,
  loadConnectorCatalogCandidate,
  parseConnectorCatalogActivePointer,
} from "../connector-catalog/artifacts/loader";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
} from "../connector-catalog/compatibility";
import { connectorCatalogRuntimeProjectionPayload } from "../connector-catalog/runtime-projection";

function publishedCatalog() {
  const value: unknown = JSON.parse(
    readFileSync(
      new URL("./fixtures/published-v4-catalog.json", import.meta.url),
      "utf8",
    ),
  );
  return connectorCatalogV4ArtifactSchema.parse(value);
}

function requiredConnector(
  artifact: ConnectorCatalogArtifact,
  slug: string,
): ConnectorCatalogArtifactConnector {
  const connector = artifact.connectors.find((candidate) => {
    return candidate.slug === slug;
  });
  if (connector === undefined) {
    throw new Error(`Missing published fixture connector: ${slug}`);
  }
  return connector;
}

function snapshot(
  artifact: ConnectorCatalogArtifact,
  schemaVersion: ConnectorCatalogGeneration = artifact.artifactSchemaVersion,
) {
  const bytes = Buffer.from(JSON.stringify(artifact));
  return {
    schemaVersion,
    catalogGzip: encodeConnectorCatalogSnapshot(bytes),
    catalogRawSize: bytes.length,
    catalogVersion: artifact.catalogVersion,
    catalogDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function decode(artifact: ConnectorCatalogArtifact) {
  return decodeConnectorCatalogSnapshot(snapshot(artifact)).artifact;
}

function filteredMethods(artifact: ConnectorCatalogArtifact) {
  return evaluateConnectorCatalogCompatibility({
    artifact,
    capability: connectorCatalogExecutableCapabilityState({
      isConfigured: () => {
        return true;
      },
    }),
  });
}

describe("generation-specific connector catalog readers", () => {
  it("reads published v4 HTTP contracts and preserves Plaud metadata without a skill", () => {
    const artifact = publishedCatalog();
    const decoded = decode(artifact);
    expect(decoded).toEqual(artifact);
    const plaud = requiredConnector(decoded, "plaud-mcp");
    expect(plaud.mcp).toEqual({
      transport: "streamable-http",
      endpoint: "https://mcp.plaud.ai/mcp",
    });
    expect(plaud.skill).toEqual({ kind: "none" });
    expect(
      JSON.parse(
        connectorCatalogRuntimeProjectionPayload(plaud).toString("utf8"),
      ),
    ).toEqual(plaud);
    expect(
      filteredMethods(decoded).find((method) => {
        return method.connectorSlug === "plaud-mcp";
      }),
    ).toEqual({
      connectorSlug: "plaud-mcp",
      authMethodId: "automatic",
      reasons: [
        "unsupported-protocol",
        "missing-grant-provider",
        "missing-access-provider",
      ],
    });
  });

  it("keeps the default reader strictly v3 and rejects v4 data carrying a v3 header", () => {
    const artifact = publishedCatalog();
    const { schemaVersion: _schemaVersion, ...defaultArgs } =
      snapshot(artifact);
    expect(() => {
      decodeConnectorCatalogSnapshot(defaultArgs);
    }).toThrow("unsupported-schema");
    expect(() => {
      decodeConnectorCatalogSnapshot(
        snapshot({ ...artifact, artifactSchemaVersion: 3 }),
      );
    }).toThrow("invalid-artifact");
    const legacy = {
      ...artifact,
      artifactSchemaVersion: 3 as const,
      connectors: artifact.connectors.filter((connector) => {
        return connector.mcp === undefined;
      }),
    };
    const { schemaVersion: _legacySchemaVersion, ...legacyArgs } =
      snapshot(legacy);
    expect(decodeConnectorCatalogSnapshot(legacyArgs).artifact).toEqual(legacy);
  });

  it("binds both deep and attested snapshot decoders to the requested generation and digest", () => {
    const args = snapshot(publishedCatalog());
    for (const reader of [
      decodeConnectorCatalogSnapshot,
      decodeAttestedConnectorCatalogSnapshot,
    ]) {
      expect(() => {
        reader({ ...args, schemaVersion: 3 });
      }).toThrow("unsupported-schema");
      expect(() => {
        reader({ ...args, catalogDigest: `sha256:${"0".repeat(64)}` });
      }).toThrow("digest-mismatch");
    }
  });

  it("binds active pointers and candidate loads to their explicit generation", async () => {
    const artifact = publishedCatalog();
    const rawBytes = Buffer.from(JSON.stringify(artifact));
    const pointer = {
      catalogVersion: artifact.catalogVersion,
      catalogKey: `connectors/v4/releases/${artifact.catalogVersion}/catalog.json`,
      catalogDigest: snapshot(artifact).catalogDigest,
    };
    const pointerBytes = Buffer.from(JSON.stringify(pointer));
    expect(parseConnectorCatalogActivePointer(pointerBytes, 4)).toEqual(
      pointer,
    );
    expect(() => {
      parseConnectorCatalogActivePointer(pointerBytes);
    }).toThrow("invalid-pointer");
    const reader = {
      readArtifact: async () => {
        return rawBytes;
      },
    };
    const candidate = await loadConnectorCatalogCandidate({
      pointer,
      reader,
      schemaVersion: 4,
    });
    expect(candidate.identity).toEqual({ ...pointer, schemaVersion: 4 });
    expect(candidate.rawBytes).toEqual(rawBytes);
    await expect(
      loadConnectorCatalogCandidate({ pointer, reader }),
    ).rejects.toThrow("invalid-pointer");
    expect(() => {
      parseConnectorCatalogActivePointer(
        Buffer.from(
          JSON.stringify({
            ...pointer,
            catalogKey: "connectors/v4/releases/other/catalog.json",
          }),
        ),
        4,
      );
    }).toThrow("invalid-pointer");
  });

  it("classifies protocol only from metadata despite crossed slug names", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    const http = requiredConnector(artifact, "019sms");
    plaud.slug = "recording-tools";
    http.slug = "messages-mcp";
    const decoded = decode(artifact);
    expect(requiredConnector(decoded, "recording-tools").mcp).toEqual(
      plaud.mcp,
    );
    expect(requiredConnector(decoded, "messages-mcp").mcp).toBeUndefined();
    const filtered = filteredMethods(decoded);
    expect(
      filtered.find((method) => {
        return method.connectorSlug === "recording-tools";
      })?.reasons,
    ).toContain("unsupported-protocol");
    expect(
      filtered.filter((method) => {
        return method.connectorSlug === "messages-mcp";
      }),
    ).toEqual([]);
  });

  it.each([
    "http://mcp.example.com/mcp",
    "https://user:secret@mcp.example.com/mcp",
    "https://mcp.example.com/mcp?token=value",
    "https://mcp.example.com/mcp#fragment",
    "https://127.0.0.1/mcp",
    "https://mcp.internal/mcp",
    "https://mcp.example.com/{tenant}",
  ])("rejects unsafe MCP endpoints: %s", (endpoint) => {
    const artifact = publishedCatalog();
    requiredConnector(artifact, "plaud-mcp").mcp = {
      transport: "streamable-http",
      endpoint,
    };
    expect(() => {
      decode(artifact);
    }).toThrow("invalid-artifact");
  });

  it("rejects a bundled skill on every explicit MCP connector", () => {
    const artifact = publishedCatalog();
    requiredConnector(artifact, "plaud-mcp").skill = {
      kind: "bundled",
      storageName: "connector-skill@plaud-mcp",
      versionId: "a".repeat(64),
      storageVersionPrefix: `__system__/volume/connector-skill@plaud-mcp/${"a".repeat(64)}`,
      size: 128,
      archiveSize: 256,
      fileCount: 1,
    };
    expect(() => {
      decode(artifact);
    }).toThrow("invalid-artifact");
  });

  it("recognizes no-auth metadata without making its grant or access executable", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    plaud.authMethods = [
      {
        id: "public",
        label: "Connect",
        description: null,
        visible: true,
        storage: { version: 1, secrets: [], variables: [] },
        grant: { kind: "none" },
        access: { kind: "none" },
        revoke: { kind: "none" },
      },
    ];
    expect(
      filteredMethods(decode(artifact)).find((method) => {
        return method.connectorSlug === "plaud-mcp";
      })?.reasons,
    ).toEqual([
      "unsupported-protocol",
      "missing-grant-provider",
      "missing-access-provider",
    ]);
    plaud.mcp = undefined;
    expect(() => {
      decode(artifact);
    }).toThrow("invalid-artifact");
  });

  it("does not execute MCP merely because its manual authentication is supported", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    const http = requiredConnector(artifact, "019sms");
    plaud.authMethods = http.authMethods;
    artifact.connectors = [plaud];
    const filtered = filteredMethods(decode(artifact));
    expect(filtered.length).toBeGreaterThan(0);
    expect(
      filtered.every((method) => {
        return method.reasons.includes("unsupported-protocol");
      }),
    ).toBe(true);
  });

  it("rejects mismatched Automatic token storage and access bindings", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    for (const method of plaud.authMethods) {
      if (method.access.kind === "automatic") {
        method.access.inputs.accessToken = "$secrets.UNRELATED_TOKEN";
      }
    }
    expect(() => {
      decode(artifact);
    }).toThrow("invalid-artifact");
  });

  it("preserves replacement metadata and rejects coexisting predecessors", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    plaud.replaces = { connectorSlug: "plaud" };
    expect(requiredConnector(decode(artifact), "plaud-mcp").replaces).toEqual({
      connectorSlug: "plaud",
    });
    plaud.replaces = { connectorSlug: "019sms" };
    expect(() => {
      decode(artifact);
    }).toThrow("invalid-artifact");
  });

  it("rejects protocol firewall mismatch and public endpoint leakage", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    plaud.mcp = {
      transport: "streamable-http",
      endpoint: "https://other.example.com/mcp",
    };
    expect(() => {
      decode(artifact);
    }).toThrow("relationship-mismatch");
    plaud.mcp.endpoint = "https://mcp.plaud.ai/PLAUD_MCP_ACCESS_TOKEN";
    expect(() => {
      decode(artifact);
    }).toThrow("public-leakage");
  });
});
