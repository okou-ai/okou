import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import { getClientConfig, handleError } from "../core/client-factory";
import { withAbsoluteHostedUrls } from "./host";

export async function readArtifactDownload(reference: string) {
  const client = initClient(artifactDownloadsContract, await getClientConfig());
  const response = await client.download({ params: { reference } });
  if (response.status !== 200) handleError(response, "Artifact unavailable");
  const result = response.body;
  if (result.kind === "file") return result;
  return {
    ...result,
    site: await withAbsoluteHostedUrls(result.site),
  };
}

export async function readHostedArtifactFiles(reference: string) {
  const client = initClient(artifactDownloadsContract, await getClientConfig());
  const response = await client.files({ params: { reference } });
  if (response.status !== 200) handleError(response, "Hosted site unavailable");
  return withAbsoluteHostedUrls(response.body);
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
