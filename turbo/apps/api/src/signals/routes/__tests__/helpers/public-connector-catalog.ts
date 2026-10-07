import { createHash, randomUUID } from "node:crypto";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { cronConnectorCatalogContract } from "@okouai/api-contracts/contracts/cron";
import { getConnectorAuthProviderRegistrationCapabilities } from "@okouai/connectors/auth-providers";
import type {
  ConnectorCatalogArtifact,
  ConnectorCatalogAuthMethod,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { onTestFinished } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import {
  env,
  mockEnv,
  mockOptionalEnv,
  optionalEnv,
} from "../../../../lib/env";
import { API_TEST_CONNECTOR_CATALOG } from "../../../../test-fixtures/connector-catalog";
import { cronConnectorCatalogRoutes } from "../../cron-connector-catalog";

export { API_TEST_CONNECTOR_CATALOG };

/** Publish external artifacts through the real, source-scoped catalog route. */
export function createPublicConnectorCatalog(
  context: TestContext,
  options: { readonly cleanupOwnership?: "caller" } = {},
) {
  const previousBucket = env("R2_USER_STORAGES_BUCKET_NAME");
  const previousCronSecret = env("CRON_SECRET");
  const kmsKeyId = env("SECRETS_KMS_KEY_ID");
  const providerConfiguration = new Map(
    getConnectorAuthProviderRegistrationCapabilities().flatMap(
      (registration) => {
        return registration.requiredConfigurationNames.map((name) => {
          return [name, optionalEnv(name)] as const;
        });
      },
    ),
  );
  const bucket = `test-public-connector-catalog-${randomUUID()}`;
  const cronSecret = `test-cron-${randomUUID()}`;
  mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
  mockEnv("CRON_SECRET", cronSecret);
  const cleanups: (() => Promise<void>)[] = [];
  let storage = context.mocks.s3.send.getMockImplementation();
  let cleaned = false;

  async function cleanup() {
    if (cleaned) {
      return;
    }
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockEnv("CRON_SECRET", cronSecret);
    mockEnv("SECRETS_KMS_KEY_ID", kmsKeyId);
    for (const [name, value] of providerConfiguration) {
      mockOptionalEnv(name, value);
    }
    if (storage) {
      context.mocks.s3.send.mockImplementation(storage);
    }
    for (const ownedCleanup of [...cleanups].reverse()) {
      await ownedCleanup();
    }
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", previousBucket);
    mockEnv("CRON_SECRET", previousCronSecret);
    cleaned = true;
  }
  if (options.cleanupOwnership !== "caller") {
    onTestFinished(cleanup);
  }

  function stage(catalog: ConnectorCatalogArtifact) {
    if (cleaned) {
      throw new Error("Public connector catalog was already cleaned up");
    }
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", bucket);
    mockEnv("CRON_SECRET", cronSecret);
    const catalogVersion = `public-test-${randomUUID()}`;
    const catalogBytes = Buffer.from(
      JSON.stringify({ ...catalog, catalogVersion }),
    );
    const catalogKey = `connectors/v4/releases/${catalogVersion}/catalog.json`;
    const objects = new Map([
      [catalogKey, catalogBytes],
      [
        "connectors/v4/active.json",
        Buffer.from(
          JSON.stringify({
            catalogVersion,
            catalogKey,
            catalogDigest: `sha256:${createHash("sha256").update(catalogBytes).digest("hex")}`,
          }),
        ),
      ],
    ]);
    const previous = context.mocks.s3.send.getMockImplementation();
    context.mocks.s3.send.mockImplementation((...args: unknown[]) => {
      const command = args[0];
      if (
        command instanceof GetObjectCommand &&
        command.input.Bucket === bucket &&
        objects.has(command.input.Key ?? "")
      ) {
        const bytes = objects.get(command.input.Key ?? "");
        if (!bytes) {
          throw new Error("Expected a catalog object");
        }
        return Promise.resolve({
          ContentLength: bytes.length,
          Body: {
            async *[Symbol.asyncIterator]() {
              yield bytes;
            },
          },
        });
      }
      if (!previous) {
        throw new Error("Unexpected non-catalog S3 request");
      }
      return previous(...args);
    });
    storage = context.mocks.s3.send.getMockImplementation();
    return {
      catalogVersion,
      catalogDigest: `sha256:${createHash("sha256").update(catalogBytes).digest("hex")}`,
    };
  }

  async function publish(catalog: ConnectorCatalogArtifact) {
    stage(catalog);
    const synced = await accept(
      setupApp({ context, routes: cronConnectorCatalogRoutes })(
        cronConnectorCatalogContract,
      ).sync({ headers: { authorization: `Bearer ${cronSecret}` } }),
      [200],
    );
    if (synced.body.outcome !== "accepted") {
      throw new Error(`Catalog publication failed: ${synced.body.outcome}`);
    }
  }

  return {
    stage,
    publish,
    cleanup,
    onCleanup(ownedCleanup: () => Promise<void>) {
      storage = context.mocks.s3.send.getMockImplementation();
      cleanups.push(ownedCleanup);
    },
  };
}

/** Select public descriptor identities, not stored account credentials. */
export function catalogWithAuthMethod(
  {
    connectorSlug,
    authMethodId,
  }: { connectorSlug: string; authMethodId: string },
  update: (method: ConnectorCatalogAuthMethod) => ConnectorCatalogAuthMethod,
): ConnectorCatalogArtifact {
  let found = false;
  const connectors = API_TEST_CONNECTOR_CATALOG.connectors.map((connector) => {
    if (connector.slug !== connectorSlug) {
      return connector;
    }
    return {
      ...connector,
      authMethods: connector.authMethods.map((method) => {
        if (method.id !== authMethodId) {
          return method;
        }
        found = true;
        return update(method);
      }),
    };
  });
  if (!found) {
    throw new Error(
      `Catalog auth method missing: ${connectorSlug}/${authMethodId}`,
    );
  }
  return { ...API_TEST_CONNECTOR_CATALOG, connectors };
}

export function catalogWithManualConnector({
  connectorSlug,
  authMethodId,
}: {
  connectorSlug: string;
  authMethodId: string;
}): ConnectorCatalogArtifact {
  const existingConnector = API_TEST_CONNECTOR_CATALOG.connectors[0];
  if (!existingConnector) {
    throw new Error("Expected an existing catalog connector");
  }
  const privateName = `${connectorSlug.replaceAll("-", "_").toUpperCase()}_TOKEN`;
  return {
    ...API_TEST_CONNECTOR_CATALOG,
    connectors: [
      ...API_TEST_CONNECTOR_CATALOG.connectors,
      {
        slug: connectorSlug,
        label: "Temporary connector",
        description: "Exercises a publicly removed catalog target",
        category: existingConnector.category,
        generation: [],
        tags: [],
        icon: existingConnector.icon,
        skill: { kind: "none" },
        firewall: { kind: "none" },
        authMethods: [
          {
            id: authMethodId,
            label: "API token",
            description: null,
            visible: true,
            storage: { version: 1, secrets: [privateName], variables: [] },
            grant: {
              kind: "manual",
              fields: [
                {
                  privateName,
                  publicId: "credential",
                  label: "Credential",
                  required: true,
                  placeholder: null,
                  storage: "secret",
                },
              ],
            },
            access: {
              kind: "static",
              envBindings: { TOKEN: `$secrets.${privateName}` },
            },
            revoke: { kind: "none" },
          },
        ],
      },
    ],
  };
}
