import { command } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { CanonicalAssetProvenance } from "@okouai/db/jsonb-contracts/run-uploaded-file";
import {
  canonicalInputContentType,
  canonicalInputMessageFiles,
  materializeCanonicalInputFile$,
  type CanonicalInputAsset,
} from "./canonical-asset.service";

type IntegrationProvenance = Exclude<
  CanonicalAssetProvenance,
  { provider: "slack" | "agent" }
>;

export interface IntegrationInputFile {
  readonly sourceId: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly size?: number;
  readonly maxBytes?: number;
  readonly provenance: IntegrationProvenance;
  readonly download: (signal: AbortSignal) => Promise<Response>;
}

export interface IntegrationInputAsset {
  readonly sourceId: string;
  readonly asset: CanonicalInputAsset;
}

export const materializeIntegrationInputAssets$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly chatThreadId: string;
      readonly publicBrand: PublicBrand;
      readonly files: readonly IntegrationInputFile[];
    },
    signal: AbortSignal,
  ): Promise<readonly IntegrationInputAsset[]> => {
    const assets: IntegrationInputAsset[] = [];
    for (const file of args.files) {
      const { provider, installationId, externalFileId } = file.provenance;
      const asset = await set(
        materializeCanonicalInputFile$,
        {
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: args.chatThreadId,
          publicBrand: args.publicBrand,
          source: provider,
          scope: `${provider}-input`,
          key: JSON.stringify([args.orgId, installationId, externalFileId]),
          externalId: externalFileId,
          provenance: file.provenance,
          filename: file.filename,
          contentType: canonicalInputContentType(
            file.filename,
            file.contentType,
          ),
          size: file.size,
          maxBytes: file.maxBytes,
          download: file.download,
        },
        signal,
      );
      assets.push({ sourceId: file.sourceId, asset });
    }
    return assets;
  },
);

export function readyIntegrationInputAsset(
  assets: readonly IntegrationInputAsset[],
  sourceId: string,
): CanonicalInputAsset | undefined {
  return assets.find((entry) => {
    return entry.sourceId === sourceId && entry.asset.status === "ready";
  })?.asset;
}

export function integrationInputMessageFiles(
  assets: readonly IntegrationInputAsset[],
) {
  return canonicalInputMessageFiles(
    assets.map(({ asset }) => {
      return asset;
    }),
  );
}

export function canonicalInputFilePrompt(asset: CanonicalInputAsset): string {
  return `[Web file] ${asset.filename} (${asset.contentType})\n   [ID] ${asset.assetId}`;
}
