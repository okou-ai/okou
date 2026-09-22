import {
  connectorCatalogValidationAuthorityIsCurrent,
  createConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidationAuthority,
  type ConnectorCatalogValidatorIdentity,
} from "@okouai/connectors/connector-catalog/authority";
import { CONNECTOR_CATALOG_VALIDATOR_VERSION } from "@okouai/connectors/connector-catalog/version";

import { getBuildVersion, normalizeBuildCommitSha } from "../../lib/build-info";
import { env } from "../../lib/env";

const CORE_SEMVER_REGEX =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const BUILD_COMMIT_SHA_REGEX = /^[a-f0-9]{40}$/u;

export {
  connectorCatalogValidationAuthorityIsCurrent,
  createConnectorCatalogValidatorIdentity,
};
export type {
  ConnectorCatalogValidationAuthority,
  ConnectorCatalogValidatorIdentity,
};

export interface ConnectorCatalogRejectionAuthority {
  readonly backendVersion: string;
  readonly buildCommitSha: string | null;
}

export type ConnectorCatalogRejectionValidatorIdentity =
  ConnectorCatalogRejectionAuthority;

interface CoreSemVer {
  readonly major: bigint;
  readonly minor: bigint;
  readonly patch: bigint;
}

function parseCoreSemVer(version: string): CoreSemVer {
  const match = CORE_SEMVER_REGEX.exec(version);
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Invalid core SemVer: ${version}`);
  }
  return {
    major: BigInt(major),
    minor: BigInt(minor),
    patch: BigInt(patch),
  };
}

function compareCoreSemVer(left: string, right: string): -1 | 0 | 1 {
  const leftVersion = parseCoreSemVer(left);
  const rightVersion = parseCoreSemVer(right);
  if (leftVersion.major !== rightVersion.major) {
    return leftVersion.major < rightVersion.major ? -1 : 1;
  }
  if (leftVersion.minor !== rightVersion.minor) {
    return leftVersion.minor < rightVersion.minor ? -1 : 1;
  }
  if (leftVersion.patch !== rightVersion.patch) {
    return leftVersion.patch < rightVersion.patch ? -1 : 1;
  }
  return 0;
}

function createConnectorCatalogRejectionIdentity(
  identity: ConnectorCatalogRejectionValidatorIdentity,
): ConnectorCatalogRejectionValidatorIdentity {
  parseCoreSemVer(identity.backendVersion);
  if (
    identity.buildCommitSha !== null &&
    !BUILD_COMMIT_SHA_REGEX.test(identity.buildCommitSha)
  ) {
    throw new Error(
      `Invalid connector catalog rejection build commit SHA: ${identity.buildCommitSha}`,
    );
  }
  return identity;
}

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

export function currentConnectorCatalogRejectionIdentity(): ConnectorCatalogRejectionValidatorIdentity {
  return createConnectorCatalogRejectionIdentity({
    backendVersion: getBuildVersion(),
    buildCommitSha: currentBuildCommitSha(),
  });
}

export function connectorCatalogRejectionIsReusable(args: {
  readonly authority: ConnectorCatalogRejectionAuthority;
  readonly validator: ConnectorCatalogRejectionValidatorIdentity;
}): boolean {
  const versionOrder = compareCoreSemVer(
    args.authority.backendVersion,
    args.validator.backendVersion,
  );
  if (versionOrder !== 0) {
    return versionOrder > 0;
  }
  return args.authority.buildCommitSha === args.validator.buildCommitSha;
}
