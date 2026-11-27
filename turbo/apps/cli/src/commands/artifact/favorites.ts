import { Command, InvalidArgumentError, Option } from "commander";
import {
  ARTIFACT_CATALOG_CATEGORIES,
  type ArtifactCatalogCategory,
} from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  favoriteArtifact,
  listArtifactFavorites,
  unfavoriteArtifact,
} from "../../lib/api/domains/artifact-favorites";
import { withErrorHandler } from "../../lib/command/with-error-handler";

interface FavoriteOptions {
  readonly json?: boolean;
}

interface FavoritesOptions extends FavoriteOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly category?: ArtifactCatalogCategory;
  readonly keyword?: string;
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new InvalidArgumentError("limit must be an integer from 1 to 50");
  }
  return limit;
}

const favoriteHelp = `
Notes:
  - Favorites are personal and scoped to the current workspace
  - Both artifactLibrary and star must be enabled in Lab
  - Saving a favorite does not change sharing or grant access
  - Only favorite or unfavorite when the user asks
  - Use a catalog artifact ID, an Artifact link, or a shared conversation link
  - A file ID or deployment ID is not a catalog artifact ID
  - Individual artifacts inside a shared conversation snapshot cannot be favorited
  - For unavailable favorites, unfavorite using the catalog ID returned by favorites --json`;

export function createArtifactFavoriteCommand(): Command {
  return new Command("favorite")
    .description(
      "Save an accessible artifact or shared conversation to favorites",
    )
    .argument("<artifact>", "Catalog artifact UUID or supported Artifact link")
    .option("--json", "Output the catalog ID and favorite state as JSON")
    .addHelpText("after", favoriteHelp)
    .action(
      withErrorHandler(
        async (
          artifact: string,
          _options: FavoriteOptions,
          command: Command,
        ) => {
          const options = command.optsWithGlobals<FavoriteOptions>();
          const result = await favoriteArtifact(artifact);
          console.log(
            options.json
              ? JSON.stringify(result)
              : `Favorited: ${result.artifactId}\nList favorites: okou artifact favorites`,
          );
        },
      ),
    );
}

export function createArtifactUnfavoriteCommand(): Command {
  return new Command("unfavorite")
    .description("Remove a favorite, including an unavailable artifact")
    .argument("<artifact>", "Catalog artifact UUID or supported Artifact link")
    .option("--json", "Output the catalog ID and favorite state as JSON")
    .addHelpText("after", favoriteHelp)
    .action(
      withErrorHandler(
        async (
          artifact: string,
          _options: FavoriteOptions,
          command: Command,
        ) => {
          const options = command.optsWithGlobals<FavoriteOptions>();
          const result = await unfavoriteArtifact(artifact);
          console.log(
            options.json
              ? JSON.stringify(result)
              : `Not favorited: ${result.artifactId}`,
          );
        },
      ),
    );
}

export function createArtifactFavoritesCommand(): Command {
  return new Command("favorites")
    .description(
      "List personal favorites in the current workspace, newest first",
    )
    .option(
      "--limit <number>",
      "Maximum number of favorites (1-50)",
      parseLimit,
    )
    .option("--cursor <cursor>", "Continue from the previous page's cursor")
    .addOption(
      new Option(
        "--category <category>",
        "Filter by artifact category",
      ).choices(ARTIFACT_CATALOG_CATEGORIES),
    )
    .option("--keyword <keyword>", "Search currently accessible favorites")
    .option(
      "--json",
      "Output favorites, unavailable entries, and nextCursor as JSON",
    )
    .addHelpText("after", favoriteHelp)
    .action(
      withErrorHandler(async (_options: FavoritesOptions, command: Command) => {
        const options = command.optsWithGlobals<FavoritesOptions>();
        const result = await listArtifactFavorites({
          limit: options.limit,
          cursor: options.cursor,
          category: options.category,
          keyword: options.keyword,
        });
        if (options.json) {
          console.log(JSON.stringify(result));
          return;
        }
        if (result.favorites.length === 0) {
          console.log(
            "No favorites found. Save one with: okou artifact favorite <artifact>",
          );
          return;
        }
        for (const favorite of result.favorites) {
          console.log(
            `${favorite.artifact?.title ?? "Unavailable"}\n  Artifact ID: ${favorite.artifactId}\n  Favorited: ${favorite.createdAt}`,
          );
        }
        if (result.nextCursor) {
          console.log(`Next cursor: ${result.nextCursor}`);
        }
      }),
    );
}
