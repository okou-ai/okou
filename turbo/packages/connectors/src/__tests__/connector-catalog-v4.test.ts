import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
} from "../connector-catalog/artifacts/artifacts";
import { AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE } from "../connector-catalog/artifacts/mcp-auth";
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
  return connectorCatalogArtifactSchema.parse(value);
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
  artifact: Omit<ConnectorCatalogArtifact, "artifactSchemaVersion"> & {
    artifactSchemaVersion: number;
  },
) {
  const bytes = Buffer.from(JSON.stringify(artifact));
  return {
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

describe("v4 connector catalog reader", () => {
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
    ).toBeUndefined();
  });

  it("binds deep and attested snapshots to the supported schema, release, and digest", () => {
    const artifact = publishedCatalog();
    const args = snapshot(artifact);
    for (const reader of [
      decodeConnectorCatalogSnapshot,
      decodeAttestedConnectorCatalogSnapshot,
    ]) {
      expect(reader(args).artifact).toEqual(artifact);
      for (const artifactSchemaVersion of [3, 5]) {
        expect(() => {
          reader(snapshot({ ...artifact, artifactSchemaVersion }));
        }).toThrow("unsupported-schema");
      }
      expect(() => {
        reader({ ...args, catalogVersion: "another-release" });
      }).toThrow("invalid-reference");
      expect(() => {
        reader({ ...args, catalogDigest: `sha256:${"0".repeat(64)}` });
      }).toThrow("digest-mismatch");
    }
  });

  it("loads candidates only from the canonical v4 release path", async () => {
    const artifact = publishedCatalog();
    const rawBytes = Buffer.from(JSON.stringify(artifact));
    const pointer = {
      catalogVersion: artifact.catalogVersion,
      catalogKey: `connectors/v4/releases/${artifact.catalogVersion}/catalog.json`,
      catalogDigest: snapshot(artifact).catalogDigest,
    };
    const pointerBytes = Buffer.from(JSON.stringify(pointer));
    expect(parseConnectorCatalogActivePointer(pointerBytes)).toEqual(pointer);
    const reader = {
      readArtifact: async () => {
        return rawBytes;
      },
    };
    const candidate = await loadConnectorCatalogCandidate({
      pointer,
      reader,
    });
    expect(candidate.identity).toEqual({ ...pointer, schemaVersion: 4 });
    expect(candidate.rawBytes).toEqual(rawBytes);
    expect(candidate.artifact).toEqual(artifact);
    for (const catalogKey of [
      "connectors/v4/active.json",
      "connectors/v4/releases/other/catalog.json",
      `connectors/v5/releases/${artifact.catalogVersion}/catalog.json`,
    ]) {
      const invalidPointer = { ...pointer, catalogKey };
      expect(() => {
        parseConnectorCatalogActivePointer(
          Buffer.from(JSON.stringify(invalidPointer)),
        );
      }).toThrow("invalid-pointer");
      await expect(
        loadConnectorCatalogCandidate({ pointer: invalidPointer, reader }),
      ).rejects.toThrow("invalid-pointer");
    }
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
      }),
    ).toBeUndefined();
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

  it("executes no-auth MCP without a provider registration", () => {
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
      }),
    ).toBeUndefined();
    plaud.mcp = undefined;
    expect(() => {
      decode(artifact);
    }).toThrow("invalid-artifact");
  });

  it("executes manual MCP through the shared credential capability", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    const http = requiredConnector(artifact, "019sms");
    plaud.authMethods = http.authMethods;
    artifact.connectors = [plaud];
    const filtered = filteredMethods(decode(artifact));
    expect(filtered).toEqual([]);
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

  it("rejects manual MCP authentication that rewrites the fixed endpoint", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    const http = requiredConnector(artifact, "019sms");
    plaud.authMethods = http.authMethods;
    plaud.firewall = http.firewall;
    artifact.connectors = [plaud];
    if (plaud.firewall.kind !== "generated" || !plaud.mcp) {
      throw new Error("Expected generated MCP firewall fixture");
    }
    const api = plaud.firewall.config.apis[0];
    if (!api) {
      throw new Error("Expected MCP endpoint API fixture");
    }
    api.base = plaud.mcp.endpoint;
    delete api.hostPolicy;
    expect(decode(artifact).connectors).toHaveLength(1);

    api.auth.base = "https://other.example.com/mcp";
    expect(() => {
      decode(artifact);
    }).toThrow("relationship-mismatch");
  });

  it("accepts catalog-owned OAuth bearer auth for Automatic MCP", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    if (plaud.firewall.kind !== "generated") {
      throw new Error("Expected generated MCP firewall fixture");
    }
    const api = plaud.firewall.config.apis[0];
    if (!api) {
      throw new Error("Expected MCP endpoint API fixture");
    }
    api.auth = {
      headers: { Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE },
    };

    expect(requiredConnector(decode(artifact), "plaud-mcp").firewall).toEqual(
      plaud.firewall,
    );
  });

  it("rejects noncanonical catalog auth for Automatic MCP", () => {
    const invalidAuth = [
      {
        headers: {
          Authorization: "Bearer ${{ secrets.PLAUD_MCP_ACCESS_TOKEN }}",
        },
      },
      {
        headers: {
          Authorization: "Basic ${{ secrets.MCP_ACCESS_TOKEN }}",
        },
      },
      { query: { access_token: "${{ secrets.MCP_ACCESS_TOKEN }}" } },
    ];
    for (const auth of invalidAuth) {
      const artifact = publishedCatalog();
      const plaud = requiredConnector(artifact, "plaud-mcp");
      if (plaud.firewall.kind !== "generated") {
        throw new Error("Expected generated MCP firewall fixture");
      }
      const api = plaud.firewall.config.apis[0];
      if (!api) {
        throw new Error("Expected MCP endpoint API fixture");
      }
      api.auth = auth;
      expect(() => {
        decode(artifact);
      }).toThrow("relationship-mismatch");
    }
  });
});
