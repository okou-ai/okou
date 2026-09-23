import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { listConnectorCatalogBriefs } from "../../../lib/api/domains/connectors";
import type { ConnectorCatalogBrief } from "../../../lib/api/domains/connectors";
import type { GenerationType } from "./lister";

function toConnectorGenerationType(
  generationType: GenerationType,
): string | null {
  switch (generationType) {
    case "avatar-video":
      return "video";
    case "voice":
    case "music":
      return "audio";
    case "dashboard-design":
    case "docs-design":
    case "mobile-app-design":
    case "poster":
    case "presentation":
    case "report":
    case "sprite":
    case "website":
      return null;
    case "audio":
    case "code":
    case "document":
    case "image":
    case "text":
    case "video":
      return generationType;
  }
}

function findConnector(
  connectors: readonly ConnectorCatalogBrief[],
  provider: string,
): ConnectorCatalogBrief | null {
  const exact = connectors.find((connector) => {
    return connector.slug === provider;
  });
  if (exact) return exact;

  const lower = provider.toLowerCase();
  return (
    connectors.find((connector) => {
      return connector.slug.toLowerCase() === lower;
    }) ?? null
  );
}

interface ConnectorGuidance {
  readonly connectorSlug: string;
  readonly label: string;
  readonly supportsGenerationType: boolean;
}

async function resolveConnector(
  provider: string,
  generationType: GenerationType,
): Promise<ConnectorGuidance | null> {
  // Only a well-formed slug can name a catalog connector.
  const slugs = [...new Set([provider, provider.toLowerCase()])].filter(
    (slug) => {
      return connectorSlugSchema.safeParse(slug).success;
    },
  );
  const connectors = await listConnectorCatalogBriefs({ slugs });
  const connector = findConnector(connectors, provider);
  if (!connector) return null;

  const connectorGenerationType = toConnectorGenerationType(generationType);
  const supports =
    connectorGenerationType !== null &&
    connector.generation.some((entry) => {
      return entry === connectorGenerationType;
    });
  return {
    connectorSlug: connector.slug,
    label: connector.label,
    supportsGenerationType: supports,
  };
}

export async function printConnectorGuidance(
  generationType: GenerationType,
  provider: string,
): Promise<void> {
  const guidance = await resolveConnector(provider, generationType);

  if (!guidance) {
    console.log(`Provider "${provider}" is not a known connector.`);
    console.log("");
    console.log(
      `Run "okou generate ${generationType}" to see every provider available for this generation type.`,
    );
    return;
  }

  if (!guidance.supportsGenerationType) {
    console.log(
      `${guidance.label} (${guidance.connectorSlug}) does not advertise ${generationType} generation.`,
    );
    console.log("");
    console.log(
      `Run "okou generate ${generationType}" to see every provider that supports this generation type.`,
    );
    return;
  }

  console.log(
    `${guidance.label} (${guidance.connectorSlug}) handles ${generationType} generation through its own connector skill, not through "okou generate".`,
  );
  console.log("");
  console.log(`Next steps:`);
  console.log(`  - Use the "${guidance.connectorSlug}" skill in this session.`);
  console.log(
    `  - Or call the connector directly via its documented endpoints.`,
  );
  console.log("");
  console.log(
    `Run "okou connector status ${guidance.connectorSlug}" to verify the connector is connected and authorized for the current agent.`,
  );
}
