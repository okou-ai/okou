import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifact,
  type ConnectorCatalogArtifactConnector,
} from "../connector-catalog/artifacts/artifacts";
import { AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE } from "../connector-catalog/artifacts/mcp-auth";
import {
  loadConnectorCatalogCandidate,
  parseConnectorCatalogActivePointer,
  validateConnectorCatalogCandidateBytes,
} from "../connector-catalog/artifacts/loader";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
} from "../connector-catalog/compatibility";
import { connectorCatalogEntryPayload } from "../connector-catalog/entry-payload";
import { connectorCatalogFirewallConfig } from "../connector-catalog/artifacts/relationships";
import {
  createRunnerRuntimeFirewallCatalog,
  projectRunnerRuntimeFirewall,
} from "../firewall-metadata/runner-runtime-catalog";

function configuredMcpArtifact(headers: Record<string, string>) {
  const artifact = publishedCatalog();
  const connector = requiredConnector(artifact, "plaud-mcp");
  if (connector.firewall.kind !== "generated") {
    throw new Error("Expected generated MCP firewall fixture");
  }
  const api = connector.firewall.config.apis[0];
  if (!api) {
    throw new Error("Expected MCP endpoint API fixture");
  }
  api.auth = { headers };
  return artifact;
}

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

function catalogPointer(catalogVersion: string, rawBytes: Uint8Array) {
  return {
    catalogVersion,
    catalogKey: `connectors/v4/releases/${catalogVersion}/catalog.json`,
    catalogDigest: `sha256:${createHash("sha256").update(rawBytes).digest("hex")}`,
  };
}

function candidate(
  artifact: Omit<ConnectorCatalogArtifact, "artifactSchemaVersion"> & {
    artifactSchemaVersion: number;
  },
) {
  const rawBytes = Buffer.from(JSON.stringify(artifact));
  return {
    pointer: catalogPointer(artifact.catalogVersion, rawBytes),
    rawBytes,
  };
}

function decode(artifact: ConnectorCatalogArtifact) {
  return validateConnectorCatalogCandidateBytes(candidate(artifact)).artifact;
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
      JSON.parse(connectorCatalogEntryPayload(plaud).toString("utf8")),
    ).toEqual(plaud);
    expect(
      filteredMethods(decoded).find((method) => {
        return method.connectorSlug === "plaud-mcp";
      }),
    ).toBeUndefined();
  });

  it("binds candidates to the supported schema, release, and digest", () => {
    const artifact = publishedCatalog();
    const args = candidate(artifact);
    expect(validateConnectorCatalogCandidateBytes(args).artifact).toEqual(
      artifact,
    );
    for (const artifactSchemaVersion of [3, 5]) {
      expect(() => {
        validateConnectorCatalogCandidateBytes(
          candidate({ ...artifact, artifactSchemaVersion }),
        );
      }).toThrow("unsupported-schema");
    }
    expect(() => {
      validateConnectorCatalogCandidateBytes({
        ...args,
        pointer: catalogPointer("another-release", args.rawBytes),
      });
    }).toThrow("invalid-reference");
    expect(() => {
      validateConnectorCatalogCandidateBytes({
        ...args,
        pointer: {
          ...args.pointer,
          catalogDigest: `sha256:${"0".repeat(64)}`,
        },
      });
    }).toThrow("digest-mismatch");
  });

  it("validates AWS firewall rules through the shared semantic parser", () => {
    const artifact = publishedCatalog();
    const connector = requiredConnector(artifact, "019sms");
    if (connector.firewall.kind !== "generated") {
      throw new Error("Expected generated firewall fixture");
    }
    const api = connector.firewall.config.apis[0];
    const permission = api?.permissions?.[0];
    if (api === undefined || permission === undefined) {
      throw new Error("Expected firewall permission fixture");
    }
    api.auth = {
      awsSigv4: {
        accessKeyId: "${{ vars.SMS019_USERNAME }}",
        secretAccessKey: "${{ secrets.SMS019_API_TOKEN }}",
      },
    };
    permission.rules = ["POST / AWS sigv4=ec2 action=DescribeInstances"];
    expect(decode(artifact)).toEqual(artifact);

    delete api.auth.awsSigv4;
    expect(() => {
      decode(artifact);
    }).toThrow(
      expect.objectContaining({
        code: "relationship-mismatch",
        relationshipRule: "invalid-firewall-permission",
      }),
    );

    api.auth.awsSigv4 = {
      accessKeyId: "${{ vars.SMS019_USERNAME }}",
      secretAccessKey: "${{ secrets.SMS019_API_TOKEN }}",
    };
    permission.rules = ["POST / AWS action=DescribeInstances"];
    expect(() => {
      decode(artifact);
    }).toThrow(
      expect.objectContaining({
        code: "relationship-mismatch",
        relationshipRule: "invalid-firewall-permission",
      }),
    );
  });

  it("loads candidates only from the canonical v4 release path", async () => {
    const artifact = publishedCatalog();
    const { pointer, rawBytes } = candidate(artifact);
    const pointerBytes = Buffer.from(JSON.stringify(pointer));
    expect(parseConnectorCatalogActivePointer(pointerBytes)).toEqual(pointer);
    const reader = {
      readArtifact: async () => {
        return rawBytes;
      },
    };
    const loaded = await loadConnectorCatalogCandidate({
      pointer,
      reader,
    });
    expect(loaded.identity).toEqual({ ...pointer, schemaVersion: 4 });
    expect(loaded.rawBytes).toEqual(rawBytes);
    expect(loaded.artifact).toEqual(artifact);
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

  it("rejects removed replacement metadata", () => {
    const artifact = publishedCatalog();
    const plaud = requiredConnector(artifact, "plaud-mcp");
    Object.assign(plaud, { replaces: { connectorSlug: "plaud" } });
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

  it.each([
    "X-Datadog-MCP-Toolsets",
    "x-datadog-mcp-toolsets",
    "X-DATADOG-MCP-TOOLSETS",
  ])(
    "preserves supported static %s through catalog and runtime projection",
    (name) => {
      const headers = {
        Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE,
        [name]: "all,cases,apm,live-debugger,future-toolset",
      };
      const artifact = configuredMcpArtifact(headers);
      const connector = requiredConnector(decode(artifact), "plaud-mcp");
      const firewall = connectorCatalogFirewallConfig(connector);
      if (firewall === null) {
        throw new Error("Expected the accepted MCP firewall");
      }
      expect(
        JSON.parse(connectorCatalogEntryPayload(connector).toString("utf8")),
      ).toEqual(connector);
      const runtime = createRunnerRuntimeFirewallCatalog([
        projectRunnerRuntimeFirewall(firewall),
      ]);
      expect(runtime.firewalls[connector.slug]?.apis[0]?.auth.headers).toEqual(
        headers,
      );

      const changed = requiredConnector(
        decode(configuredMcpArtifact({ ...headers, [name]: "all,cases" })),
        "plaud-mcp",
      );
      const changedFirewall = connectorCatalogFirewallConfig(changed);
      if (changedFirewall === null) {
        throw new Error("Expected the changed MCP firewall");
      }
      expect(
        createRunnerRuntimeFirewallCatalog([
          projectRunnerRuntimeFirewall(changedFirewall),
        ]).catalogDigest,
      ).not.toBe(runtime.catalogDigest);
    },
  );

  it.each([
    "Authorization",
    "authorization",
    "Proxy-Authorization",
    "Cookie",
    "X-Api-Key",
    "Host",
    "Forwarded",
    "X-Forwarded-Host",
    "Connection",
    "Content-Length",
    "Transfer-Encoding",
    "Content-Type",
    "Accept",
    "MCP-Protocol-Version",
    "Mcp-Session-Id",
    "Last-Event-ID",
    "X-Okou-Connector-Intent",
    "X-Unreviewed-Configuration",
  ])("rejects an unsupported Automatic MCP header: %s", (name) => {
    expect(() => {
      return decode(
        configuredMcpArtifact({
          Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE,
          "X-Datadog-MCP-Toolsets": "all,cases",
          [name]: "override",
        }),
      );
    }).toThrow();
  });

  it("rejects folded duplicates and excessive header profiles", () => {
    const headers = {
      Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE,
      "X-Datadog-MCP-Toolsets": "all,cases",
    };
    expect(() => {
      return decode(
        configuredMcpArtifact({
          ...headers,
          "x-datadog-mcp-toolsets": "all",
        }),
      );
    }).toThrow("relationship-mismatch");
    expect(() => {
      return decode(
        configuredMcpArtifact({
          ...headers,
          ...Object.fromEntries(
            Array.from({ length: 7 }, (_, index) => {
              return [`X-Unreviewed-${index}`, "configuration"];
            }),
          ),
        }),
      );
    }).toThrow("relationship-mismatch");
  });

  it.each([
    "",
    "all,",
    ",all",
    "all,,cases",
    "all, cases",
    "ALL",
    "0toolset",
    "all\n",
    "all\r",
    "all\u0000",
    "all\t",
    "all\u2028",
    "all\u0085",
    "all;cases",
    "all,cáses",
    "${{ secrets.EXTRA_TOKEN }}",
    "${{ vars.TOOLSETS }}",
    "a".repeat(65),
    Array.from({ length: 33 }, (_, index) => {
      return `toolset-${index}`;
    }).join(","),
    Array.from({ length: 17 }, () => {
      return "a".repeat(64);
    }).join(","),
  ])("rejects malformed or oversized toolset selection %j", (value) => {
    expect(() => {
      return decode(
        configuredMcpArtifact({
          Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE,
          "X-Datadog-MCP-Toolsets": value,
        }),
      );
    }).toThrow("relationship-mismatch");
  });

  it.each([
    "a".repeat(64),
    Array.from({ length: 32 }, (_, index) => {
      return `toolset-${index}`;
    }).join(","),
    [
      "a".repeat(64),
      ...Array.from({ length: 15 }, () => {
        return "b".repeat(63);
      }),
    ].join(","),
  ])("accepts bounded toolset identifier lists (%#)", (value) => {
    const artifact = configuredMcpArtifact({
      Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE,
      "X-Datadog-MCP-Toolsets": value,
    });
    expect(decode(artifact)).toEqual(artifact);
  });

  it("requires canonical OAuth authority without accepting extra auth modes", () => {
    for (const extra of [
      { query: { toolsets: "all" } },
      { base: "https://other.example.com/mcp" },
      { awsSigv4: { accessKeyId: "key", secretAccessKey: "secret" } },
    ]) {
      const artifact = configuredMcpArtifact({
        Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE,
        "X-Datadog-MCP-Toolsets": "all,cases",
      });
      const connector = requiredConnector(artifact, "plaud-mcp");
      if (connector.firewall.kind !== "generated") {
        throw new Error("Expected generated MCP firewall fixture");
      }
      const api = connector.firewall.config.apis[0];
      if (!api) {
        throw new Error("Expected MCP endpoint API fixture");
      }
      Object.assign(api.auth, extra);
      expect(() => {
        return decode(artifact);
      }).toThrow();
    }
    expect(() => {
      return decode(
        configuredMcpArtifact({
          "X-Datadog-MCP-Toolsets": "all,cases",
        }),
      );
    }).toThrow("relationship-mismatch");

    const artifact = configuredMcpArtifact({
      Authorization: AUTOMATIC_MCP_RUNTIME_BEARER_TEMPLATE,
      "X-Datadog-MCP-Toolsets": "all,cases",
    });
    requiredConnector(artifact, "plaud-mcp").authMethods = [
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
    expect(() => {
      return decode(artifact);
    }).toThrow("relationship-mismatch");
  });
});
