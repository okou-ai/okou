import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  artifactShareTargetSchema,
  type ArtifactShareStatus,
  type ArtifactShareTarget,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { getPlatformOrigin } from "../../platform-url";
import { getClientConfig, handleError } from "../core/client-factory";

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
  const client = initClient(artifactSharesContract, await getClientConfig());
  const response = await client.status({ body: target });
  if (response.status !== 200) {
    handleError(response, "Could not read artifact sharing");
  }
  return response.body;
}

export async function setArtifactAudience(
  target: ArtifactShareTarget,
  audience: ArtifactShareStatus["audience"],
): Promise<ArtifactShareStatus> {
  const status = await getArtifactShareStatus(target);
  if (audience === "private" && status.audience === "private") {
    return status;
  }
  if (
    status.audience === audience &&
    status.url &&
    status.selectedTarget?.kind === target.kind &&
    status.selectedTarget.id === target.id &&
    status.selectedVersion === status.candidateVersion &&
    !(
      (audience === "organization" || target.kind === "html") &&
      status.shortUrl === null
    )
  ) {
    return status;
  }
  const client = initClient(artifactSharesContract, await getClientConfig());
  const response = await client.update({ body: { target, audience } });
  if (response.status !== 200) {
    handleError(
      response,
      "Could not change artifact visibility. Rerun without --visibility before retrying; the change may have applied.",
    );
  }
  return response.body;
}
