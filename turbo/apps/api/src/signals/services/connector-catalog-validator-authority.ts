import {
  createConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidatorIdentity,
} from "@okouai/connectors/connector-catalog/authority";
import { CONNECTOR_CATALOG_VALIDATOR_VERSION } from "@okouai/connectors/connector-catalog/version";

import { normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";

export type { ConnectorCatalogValidatorIdentity };

function currentBuildCommitSha(): string | null {
  const environment = env("ENV");
  if (environment === "production") {
    return null;
  }
  const buildCommitSha = normalizeBuildCommitSha(env("GIT_COMMIT_SHA"));
  if (environment === "preview" && buildCommitSha === null) {
    throw new Error(
      "Preview connector catalog authority requires a commit SHA",
    );
  }
  return buildCommitSha;
}

export function currentConnectorCatalogValidatorIdentity(): ConnectorCatalogValidatorIdentity {
  return createConnectorCatalogValidatorIdentity({
    validatorVersion: CONNECTOR_CATALOG_VALIDATOR_VERSION,
    buildCommitSha: currentBuildCommitSha(),
  });
}
