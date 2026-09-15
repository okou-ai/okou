import { command } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import type { CanonicalAssetProvenance } from "@okouai/db/jsonb-contracts/run-uploaded-file";
import { inferMimetype } from "../../lib/mimetype";
import { sanitizeArtifactFilename } from "../../lib/file-url";
import {
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
    const batchDeadline = AbortSignal.timeout(30_000);
    const assets: IntegrationInputAsset[] = [];
    for (const file of args.files) {
      const { provider, installationId, messageId, externalFileId } =
        file.provenance;
      const asset = await set(
        materializeCanonicalInputFile$,
        {
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: args.chatThreadId,
          publicBrand: args.publicBrand,
          source: provider === "lark" ? "feishu" : provider,
          scope: `${provider}-input`,
          key: JSON.stringify([
            args.orgId,
            installationId,
            messageId,
            externalFileId,
          ]),
          externalId: externalFileId,
          provenance: file.provenance,
          filename: sanitizeArtifactFilename(file.filename),
          contentType: file.contentType ?? inferMimetype(file.filename),
          size: file.size,
          maxBytes: file.maxBytes,
          download: (fileSignal) => {
            return file.download(AbortSignal.any([fileSignal, batchDeadline]));
          },
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
  return assets.flatMap(({ asset }) => {
    return asset.status === "ready"
      ? [
          {
            id: asset.assetId,
            filename: asset.filename,
            contentType: asset.contentType,
          },
        ]
      : [];
  });
}

export function canonicalInputFilePrompt(asset: CanonicalInputAsset): string {
  return `[Web file] ${asset.filename} (${asset.contentType})\n   [ID] ${asset.assetId}`;
}
