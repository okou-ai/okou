import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  artifactAccessContract,
  type ArtifactVisibilityResponse,
} from "@okouai/api-contracts/contracts/artifact-access";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactShareTargetSchema,
  type ArtifactShareStatus,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { getPlatformOrigin } from "../../platform-url";
import { getClientConfig, handleError } from "../core/client-factory";

function toShareStatus(
  target: ArtifactShareTarget,
  response: ArtifactVisibilityResponse,
): ArtifactShareStatus {
  return {
    ownerUrl: response.ownerUrl ?? "",
    shareId: null,
    audience: response.visibility,
    organization: response.organization,
    selectedTarget: response.visibility === "private" ? null : target,
    selectedVersion: null,
    candidateVersion: null,
    url: response.shareUrl,
    shortUrl: response.shortUrl,
  };
}

async function readArtifactVisibility(target: ArtifactShareTarget): Promise<{
  readonly artifactId: string;
  readonly status: ArtifactShareStatus;
}> {
  const client = initClient(artifactAccessContract, await getClientConfig());
  const response = await client.getVisibility({
    params: { artifactId: target.id },
  });
  if (response.status !== 200) {
    handleError(response, "Could not read artifact sharing");
  }
  return {
    artifactId: response.body.artifactId,
    status: toShareStatus(target, response.body),
  };
}

export async function resolveArtifactShareTarget(
  artifact: string,
  kind: ArtifactShareTarget["kind"] | undefined,
): Promise<ArtifactShareTarget> {
  if (kind) {
    return artifactShareTargetSchema.parse({ kind, id: artifact });
  }
  const reference = parseArtifactReference(artifact, await getPlatformOrigin());
  if (!reference) {
    throw new Error(
      "Use an owned /artifacts/<reference> path or an artifact URL from OKOU_APP_URL. For a file or deployment UUID, add --kind file or --kind html.",
    );
  }
  const client = initClient(
    artifactReferencesContract,
    await getClientConfig(),
  );
  const response = await client.resolve({
    params: { reference: `${reference.hash}${reference.extension}` },
    query: { kind: "artifact" },
  });
  if (response.status !== 200) {
    handleError(response, "Artifact is not available to its owner");
  }
  return response.body.target;
}

export async function getArtifactShareStatus(
  target: ArtifactShareTarget,
): Promise<ArtifactShareStatus> {
  return (await readArtifactVisibility(target)).status;
}

export async function setArtifactAudience(
  target: ArtifactShareTarget,
  audience: ArtifactShareStatus["audience"],
): Promise<ArtifactShareStatus> {
  const { artifactId, status } = await readArtifactVisibility(target);
  if (audience === "private" && status.audience === "private") {
    return status;
  }
  if (
    status.audience === audience &&
    status.url &&
    status.selectedTarget?.kind === target.kind &&
    status.selectedTarget.id === target.id &&
    !(
      (audience === "organization" || target.kind === "html") &&
      status.shortUrl === null
    )
  ) {
    return status;
  }
  const client = initClient(artifactAccessContract, await getClientConfig());
  const response = await client.updateVisibility({
    params: { artifactId },
    body: { visibility: audience },
  });
  if (response.status !== 200) {
    handleError(
      response,
      "Could not change artifact visibility. Rerun without --visibility before retrying; the change may have applied.",
    );
  }
  return toShareStatus(target, response.body);
}
