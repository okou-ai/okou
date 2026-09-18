import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { getClientConfig, handleError } from "../core/client-factory";

export async function readArtifactReference(reference: string) {
  const client = initClient(
    artifactReferencesContract,
    await getClientConfig(),
  );
  const response = await client.read({ params: { reference } });
  if (response.status !== 200) handleError(response, "Artifact unavailable");
  return response.body;
}

export async function resolveOwnedArtifactReference(
  reference: string,
  kind: "file" | "html",
): Promise<string> {
  const client = initClient(
    artifactReferencesContract,
    await getClientConfig(),
  );
  const response = await client.resolve({
    params: { reference },
    query: { kind },
  });
  if (response.status !== 200)
    handleError(response, "Artifact is not available to its owner");
  return response.body.target.id;
}
