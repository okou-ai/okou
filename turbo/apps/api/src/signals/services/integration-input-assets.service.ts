import { command } from "ccstate";
import type { CanonicalAssetProvenance } from "@okouai/db/jsonb-contracts/run-uploaded-file";
import {
  canonicalInputContentType,
  canonicalInputMessageFiles,
  prepareCanonicalInputFile$,
  storeCanonicalInputFile$,
  completeCanonicalInputFile$,
  canonicalInputImportSignals,
  canonicalInputImportOutcome,
  type CanonicalInputImportPlan,
  type CanonicalInputImportReady,
  type CanonicalInputAsset,
  InputFileImportError,
} from "./canonical-asset.service";

import { downloadFeishuMessageResource$ } from "../external/feishu-client";
import { safeUrlParse, settleIncludingAbort } from "../utils";
import { isAllowedTeamsDownloadUrl } from "../../lib/teams-file-url";
import { fetchTeamsFile } from "../external/teams-bot-client";
import { buildFileDownloadUrl, getFile } from "../external/telegram-client";
import type { TeamsFileTokenPayload } from "./teams-file-token";

type IntegrationInputResource =
  | {
      readonly provider: "feishu" | "lark";
      readonly installationId: string;
      readonly messageId: string;
      readonly fileKey: string;
      readonly resourceType: "file" | "image";
    }
  | {
      readonly provider: "telegram";
      readonly botToken: string;
      readonly fileId: string;
      readonly maxBytes: number;
    }
  | { readonly provider: "teams"; readonly payload: TeamsFileTokenPayload }
  | { readonly provider: "agentphone"; readonly url: string };

type IntegrationProvenance = Extract<
  CanonicalAssetProvenance,
  { installationId: string }
>;

export interface IntegrationInputFile {
  readonly sourceId: string;
  readonly filename: string;
  readonly contentType?: string;
  readonly size?: number;
  readonly maxBytes?: number;
  readonly provenance: IntegrationProvenance;
  readonly resource: IntegrationInputResource;
}

export interface IntegrationInputAsset {
  readonly sourceId: string;
  readonly asset: CanonicalInputAsset;
}

const downloadIntegrationInputResource$ = command(
  async (
    { set },
    resource: IntegrationInputResource,
    signal: AbortSignal,
  ): Promise<Response> => {
    switch (resource.provider) {
      case "feishu":
      case "lark": {
        return await set(downloadFeishuMessageResource$, resource, signal);
      }
      case "telegram": {
        const metadata = await getFile(
          resource.botToken,
          resource.fileId,
          signal,
        );
        signal.throwIfAborted();
        if (!metadata.file_path) {
          throw new Error("Telegram file has no download path");
        }
        if ((metadata.file_size ?? 0) > resource.maxBytes) {
          throw new InputFileImportError(
            "too-large",
            "Telegram file exceeds the download limit",
          );
        }
        const response = await fetch(
          buildFileDownloadUrl(resource.botToken, metadata.file_path),
          { signal },
        );
        signal.throwIfAborted();
        return response;
      }
      case "teams": {
        if (!isAllowedTeamsDownloadUrl(resource.payload.url)) {
          throw new InputFileImportError(
            "invalid-url",
            "Invalid Teams attachment URL",
          );
        }
        const result = await fetchTeamsFile(resource.payload, signal);
        signal.throwIfAborted();
        if (result.kind === "teams-error") {
          throw new InputFileImportError(
            "download-failed",
            "Teams attachment download failed",
            result.status,
          );
        }
        return result.response;
      }
      case "agentphone": {
        if (safeUrlParse(resource.url)?.protocol !== "https:") {
          throw new InputFileImportError(
            "invalid-url",
            "Phone media URL must use HTTPS",
          );
        }
        const response = await fetch(resource.url, { signal });
        signal.throwIfAborted();
        return response;
      }
    }
  },
);

const importIntegrationInputFile$ = command(
  async (
    { set },
    plan: CanonicalInputImportPlan,
    resource: IntegrationInputFile["resource"],
    signal: AbortSignal,
  ): Promise<CanonicalInputImportReady> => {
    const response = await set(
      downloadIntegrationInputResource$,
      resource,
      signal,
    );
    signal.throwIfAborted();
    return await set(storeCanonicalInputFile$, plan, response, signal);
  },
);

const materializeIntegrationInputFile$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly chatThreadId: string;
    },
    file: IntegrationInputFile,
    signal: AbortSignal,
  ): Promise<IntegrationInputAsset> => {
    const { provider, externalFileId, installationId } = file.provenance;
    const prepared = await set(
      prepareCanonicalInputFile$,
      {
        ...args,
        source: provider,
        scope: `${provider}-input`,
        key: JSON.stringify([args.orgId, installationId, externalFileId]),
        externalId: externalFileId,
        provenance: file.provenance,
        filename: file.filename,
        contentType: canonicalInputContentType(file.filename, file.contentType),
        size: file.size,
        maxBytes: file.maxBytes,
      },
      signal,
    );
    signal.throwIfAborted();
    if (prepared.kind === "complete") {
      return { sourceId: file.sourceId, asset: prepared.asset };
    }
    const { importController, importSignal } =
      canonicalInputImportSignals(signal);
    const imported = await settleIncludingAbort(
      set(
        importIntegrationInputFile$,
        prepared.plan,
        file.resource,
        importSignal,
      ),
    );
    signal.throwIfAborted();
    const outcome = canonicalInputImportOutcome(imported, importSignal);
    if (!imported.ok) {
      importController.abort();
    }
    const asset = await set(
      completeCanonicalInputFile$,
      prepared.plan,
      outcome,
      signal,
    );
    signal.throwIfAborted();
    return { sourceId: file.sourceId, asset };
  },
);

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
      assets.push(
        await set(
          materializeIntegrationInputFile$,
          {
            userId: args.userId,
            orgId: args.orgId,
            chatThreadId: args.chatThreadId,
          },
          file,
          signal,
        ),
      );
      signal.throwIfAborted();
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
