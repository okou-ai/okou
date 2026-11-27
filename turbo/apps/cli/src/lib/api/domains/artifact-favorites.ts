import { uuid } from "zod";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { artifactFavoritesContract } from "@okouai/api-contracts/contracts/artifact-favorites";
import type { ArtifactCatalogCategory } from "@okouai/api-contracts/contracts/artifact-catalog";
import { getClientConfig, handleError } from "../core/client-factory";

const catalogIdSchema = uuid();

export async function favoriteArtifact(artifact: string) {
  const client = initClient(artifactFavoritesContract, await getClientConfig());
  const response = await client.create({
    body: catalogIdSchema.safeParse(artifact).success
      ? { artifactId: artifact }
      : { url: artifact },
  });
  if (response.status !== 200) {
    handleError(response, "Could not favorite artifact");
  }
  return response.body;
}

export async function unfavoriteArtifact(artifact: string) {
  const client = initClient(artifactFavoritesContract, await getClientConfig());
  let artifactId = artifact;
  if (!catalogIdSchema.safeParse(artifact).success) {
    const resolved = await client.resolve({ query: { url: artifact } });
    if (resolved.status !== 200) {
      handleError(
        resolved,
        "Could not resolve artifact. For unavailable favorites, use the catalog ID from okou artifact favorites --json.",
      );
    }
    artifactId = resolved.body.artifactId;
  }
  const response = await client.remove({ params: { artifactId } });
  if (response.status !== 200) {
    handleError(response, "Could not remove favorite");
  }
  return response.body;
}

export async function listArtifactFavorites(query: {
  readonly limit?: number;
  readonly cursor?: string;
  readonly category?: ArtifactCatalogCategory;
  readonly keyword?: string;
}) {
  const client = initClient(artifactFavoritesContract, await getClientConfig());
  const response = await client.list({ query });
  if (response.status !== 200) {
    handleError(response, "Could not list favorites");
  }
  return response.body;
}
