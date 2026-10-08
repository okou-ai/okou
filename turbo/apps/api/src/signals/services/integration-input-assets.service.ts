import { command } from "ccstate";
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
      readonly files: readonly IntegrationInputFile[];
    },
    signal: AbortSignal,
  ): Promise<readonly IntegrationInputAsset[]> => {
    const assets: IntegrationInputAsset[] = [];
    for (const file of args.files) {
      const { provider, externalFileId } = file.provenance;
      const key =
        file.provenance.provider === "discord"
          ? JSON.stringify([
              args.orgId,
              file.provenance.guildId,
              file.provenance.channelId,
              file.provenance.messageId,
              externalFileId,
            ])
          : JSON.stringify([
              args.orgId,
              file.provenance.installationId,
              externalFileId,
            ]);
      const asset = await set(
        materializeCanonicalInputFile$,
        {
          userId: args.userId,
          orgId: args.orgId,
          chatThreadId: args.chatThreadId,
          source: provider,
          scope: `${provider}-input`,
          key,
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
