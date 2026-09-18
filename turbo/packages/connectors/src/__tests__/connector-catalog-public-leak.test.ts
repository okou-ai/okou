import { createHash } from "node:crypto";

import {
  type ConnectorCatalogArtifact,
  SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
} from "../connector-catalog/artifacts/artifacts";
import {
  decodeConnectorCatalogSnapshot,
  encodeConnectorCatalogSnapshot,
} from "../connector-catalog/artifacts/loader";

const CONNECTOR_SLUG = "token-security";
const CATALOG_VERSION = "2026-09-03.exact-public-slug";
const STORAGE_NAME = `connector-skill@${CONNECTOR_SLUG}`;
const VERSION_ID = "a".repeat(64);
const STORAGE_VERSION_PREFIX = `__system__/volume/${STORAGE_NAME}/${VERSION_ID}`;
const PRIVATE_NAME = "TOKEN_SECURITY_API_TOKEN";
const VALUE_REF = `$secrets.${PRIVATE_NAME}`;

function catalogArtifact(
  description: string,
  privateName = PRIVATE_NAME,
  placeholder: string | null = null,
): ConnectorCatalogArtifact {
  return {
    artifactSchemaVersion: SUPPORTED_CONNECTOR_CATALOG_SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    categoryMetadata: {
      categories: [
        {
          id: "testing",
          label: "Testing",
          menuLabel: "Testing",
          groupId: null,
        },
      ],
      groups: [],
    },
    connectors: [
      {
        slug: CONNECTOR_SLUG,
        label: "Token Security",
        description,
        category: "testing",
        generation: [],
        tags: ["fixture"],
        authMethods: [
          {
            id: "api-token",
            label: "API Token",
            description: null,
            visible: true,
            storage: {
              version: 1,
              secrets: [privateName],
              variables: [],
            },
            grant: {
              kind: "manual",
              fields: [
                {
                  privateName,
                  publicId: "credential",
                  label: "API token",
                  required: true,
                  placeholder,
                  storage: "secret",
                },
              ],
            },
            access: {
              kind: "static",
              envBindings: { SERVICE_TOKEN: `$secrets.${privateName}` },
            },
            revoke: { kind: "none" },
          },
        ],
        icon: {
          key: "connectors/token-security.svg",
          invertInDarkMode: false,
        },
        skill: {
          kind: "bundled",
          storageName: STORAGE_NAME,
          versionId: VERSION_ID,
          storageVersionPrefix: STORAGE_VERSION_PREFIX,
          size: 128,
          archiveSize: 256,
          fileCount: 1,
        },
        firewall: { kind: "none" },
      },
    ],
  };
}

function decodeCatalog(
  artifact: ConnectorCatalogArtifact,
): ConnectorCatalogArtifact {
  const rawBytes = Buffer.from(`${JSON.stringify(artifact)}\n`);
  return decodeConnectorCatalogSnapshot({
    catalogGzip: encodeConnectorCatalogSnapshot(rawBytes),
    catalogRawSize: rawBytes.byteLength,
    catalogVersion: CATALOG_VERSION,
    catalogDigest: `sha256:${createHash("sha256").update(rawBytes).digest("hex")}`,
  }).artifact;
}

describe("connector catalog relationship failure details", () => {
  it.each([
    "unknown-category",
    "auth-client-presence",
    "auth-code-client-registration",
    "undeclared-storage-reference",
    "duplicate-storage-secret-owner",
    "unknown-firewall-binding",
    "firewall-permission-categories",
  ])("preserves the safe %s rule without private error content", (rule) => {
    const artifact = catalogArtifact("Public description");
    for (const connector of artifact.connectors) {
      if (rule === "unknown-category") {
        connector.category = "missing-category";
      }
      for (const method of connector.authMethods) {
        if (rule === "auth-client-presence") {
          method.client = {
            clientRegistration: "static",
            clientType: "public",
            clientId: "https://private.example/client",
          };
        }
        if (rule === "auth-code-client-registration") {
          method.client = {
            clientRegistration: "dynamic",
            clientType: "public",
          };
          method.grant = {
            kind: "auth-code",
            scopes: [],
            callbackOrigin: "web",
            outputs: { token: VALUE_REF },
          };
        }
        if (
          rule === "undeclared-storage-reference" &&
          "envBindings" in method.access
        ) {
          method.access.envBindings.SERVICE_TOKEN =
            "$secrets.UNDECLARED_PRIVATE_TOKEN";
        }
      }
      if (
        rule === "unknown-firewall-binding" ||
        rule === "firewall-permission-categories"
      ) {
        connector.firewall = {
          kind: "generated",
          billable: false,
          config: {
            apis: [
              {
                base: "https://api.example.com",
                auth: {
                  headers: {
                    Authorization:
                      "Bearer ${{ secrets.UNKNOWN_PRIVATE_TOKEN }}",
                  },
                },
                permissions: [{ name: "read", rules: ["GET /items"] }],
              },
            ],
          },
          categories:
            rule === "firewall-permission-categories"
              ? { byPermission: {}, displayOrder: ["read"] }
              : null,
          defaultAllowed: null,
          defaultUnknownPolicy: "deny",
        };
      }
    }
    if (rule === "duplicate-storage-secret-owner") {
      for (const connector of catalogArtifact("Another description")
        .connectors) {
        connector.slug = "another-connector";
        connector.skill = { kind: "none" };
        artifact.connectors.push(connector);
      }
    }

    expect(() => {
      decodeCatalog(artifact);
    }).toThrow(
      expect.objectContaining({
        code: "relationship-mismatch",
        message: "relationship-mismatch",
        relationshipRule: rule,
      }),
    );
  });
});

describe("connector catalog public projection", () => {
  it("accepts the exact public slug derived from bundled skill storage", () => {
    const artifact = decodeCatalog(
      catalogArtifact("Public connector description"),
    );

    expect(artifact.connectors[0]?.slug).toBe(CONNECTOR_SLUG);
  });

  it.each([
    ["full bundled skill storage name", STORAGE_NAME],
    ["bundled skill version ID", VERSION_ID],
    ["full bundled skill storage version prefix", STORAGE_VERSION_PREFIX],
    ["private storage name", PRIVATE_NAME],
    ["private value reference", VALUE_REF],
  ])("rejects a leaked %s", (_name, privateValue) => {
    expect(() => {
      decodeCatalog(catalogArtifact(privateValue));
    }).toThrow("public-leakage");
  });

  it.each([
    ["ABCD_EFGH", "prefix-abcd-efgh-suffix"],
    [PRIVATE_NAME, "Your token security api token"],
  ])("rejects a placeholder derived from %s", (privateName, placeholder) => {
    expect(() => {
      decodeCatalog(
        catalogArtifact("Public description", privateName, placeholder),
      );
    }).toThrow("public-leakage");
  });

  it.each([
    ["ABC_DEFG", "abc-defg"],
    ["ABCDEFGH", "abcd-efgh"],
    [PRIVATE_NAME, "Enter your credential"],
  ])(
    "accepts an unrelated placeholder for %s: %s",
    (privateName, placeholder) => {
      const artifact = catalogArtifact(
        "Public description",
        privateName,
        placeholder,
      );
      expect(decodeCatalog(artifact)).toEqual(artifact);
    },
  );

  it("keeps normalized private names public outside derived-value paths", () => {
    const artifact = catalogArtifact("Token security api token");
    for (const connector of artifact.connectors) {
      connector.tags = ["token-security-api-token"];
    }
    expect(decodeCatalog(artifact)).toEqual(artifact);
  });

  it("rejects exact private values inside public arrays", () => {
    const artifact = catalogArtifact("Public description");
    for (const connector of artifact.connectors) {
      connector.tags = [PRIVATE_NAME];
    }
    expect(() => {
      decodeCatalog(artifact);
    }).toThrow("public-leakage");
  });

  it.each(["defaultValue", "value", "neither"])(
    "checks derived private names in device fields: %s",
    (field) => {
      const artifact = catalogArtifact("Public description");
      for (const connector of artifact.connectors) {
        for (const method of connector.authMethods) {
          method.client = {
            clientType: "public",
            clientRegistration: "static",
            clientId: "fixture-device-client",
          };
          method.grant = {
            kind: "device-auth",
            scopes: [],
            outputs: { token: VALUE_REF },
            startOptions: [
              {
                privateName: "environment",
                publicId: "environment",
                kind: "select",
                label: "Environment",
                required: true,
                defaultValue:
                  field === "defaultValue" ? "token-security-api-token" : null,
                options: [
                  {
                    // Keep the default-value case independent: missing its
                    // leakage check must reach relationship-mismatch, not
                    // pass because the option value also leaks.
                    value:
                      field === "value"
                        ? "token-security-api-token"
                        : "production",
                    label: "Production",
                  },
                ],
              },
            ],
          };
        }
      }
      if (field === "neither") {
        expect(decodeCatalog(artifact)).toEqual(artifact);
      } else {
        expect(() => {
          decodeCatalog(artifact);
        }).toThrow("public-leakage");
      }
    },
  );

  it("keeps sensitive matching scoped to its connector", () => {
    const firstPrivateName = "FIRST_PRIVATE_FIELD";
    const first = catalogArtifact("Public description", firstPrivateName);
    const second = catalogArtifact(firstPrivateName, "SECOND_PRIVATE_FIELD");
    for (const connector of second.connectors) {
      connector.slug = "another-connector";
      connector.skill = { kind: "none" };
      first.connectors.push(connector);
    }
    expect(decodeCatalog(first)).toEqual(first);
  });
});
