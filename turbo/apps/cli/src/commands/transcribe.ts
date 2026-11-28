import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MIMEType } from "node:util";
import { Command } from "commander";
import { transcribeContract } from "@okouai/api-contracts/contracts/transcribe";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { VOICE_TRANSCRIPTION_MODEL } from "@okouai/api-contracts/contracts/voice-clips";
import { getClientConfig, handleError } from "../lib/api/core/client-factory";
import { downloadWebFile } from "../lib/api/domains/web";
import { withErrorHandler } from "../lib/command/with-error-handler";
import { getOkouAntigravityModel } from "../lib/okou-env";

const AUDIO_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/m4a": ".m4a",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/wave": ".wav",
  "audio/webm": ".webm",
  "audio/x-aac": ".aac",
  "audio/x-m4a": ".m4a",
  "audio/x-wav": ".wav",
};

function audioExtensionForMime(mimetype: string): string | undefined {
  return AUDIO_EXTENSION_BY_MIME[new MIMEType(mimetype).essence];
}

async function downloadVoiceClipsForNativeAudio(
  fileIds: readonly string[],
): Promise<string[]> {
  const parsed =
    transcribeContract.transcribe.body.shape.fileIds.safeParse(fileIds);
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues[0]?.message ?? "Invalid --file-id value",
    );
  }
  const settled = await Promise.allSettled(
    parsed.data.map(async (fileId, index) => {
      const rawPath = join(tmpdir(), `okou-voice-${index + 1}-${randomUUID()}`);
      const result = await downloadWebFile(fileId, rawPath);
      const extension = audioExtensionForMime(result.mimetype);
      if (!extension) {
        return result.path;
      }
      const targetPath = `${result.path}${extension}`;
      try {
        await rename(result.path, targetPath);
        return targetPath;
      } catch (error) {
        await rm(result.path, { force: true });
        throw error;
      }
    }),
  );
  const downloadedPaths: string[] = [];
  let firstError: unknown;
  let failed = false;
  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      downloadedPaths.push(outcome.value);
    } else if (!failed) {
      failed = true;
      firstError = outcome.reason;
    }
  }
  if (failed) {
    await Promise.allSettled(
      downloadedPaths.map((path) => {
        return rm(path, { force: true });
      }),
    );
    throw firstError;
  }
  return downloadedPaths;
}

function formatNativeAudioPrompt(paths: readonly string[]): string {
  const list = paths
    .map((path, index) => {
      return `${index + 1}. ${path}`;
    })
    .join("\n");
  return [
    "Audio clips downloaded for native listening (do not call `okou transcribe` again).",
    "Read each file in recording order with `read_file` to understand the user's voice message directly before replying:",
    list,
    "",
  ].join("\n");
}

export const transcribeCommand = new Command("transcribe")
  .description(
    "Transcribe audio in order. When OKOU_ANTIGRAVITY_MODEL is set, downloads audio clips for native reading with read_file unless --force-transcribe is passed; otherwise writes UTF-8 text to stdout and a temporary file (path on stderr) using model credits.",
  )
  .argument("[model]", "Audio-capable model", VOICE_TRANSCRIPTION_MODEL)
  .requiredOption(
    "--file-id <uuid>",
    "Private uploaded audio file (repeat in playback order)",
    (id: string, ids: string[]) => {
      return [...ids, id];
    },
    [],
  )
  .option(
    "--operation-id <uuid>",
    "Explicit operation identity for retries (defaults to this run and ordered input)",
  )
  .option(
    "--force-transcribe",
    "Call the transcription API even when OKOU_ANTIGRAVITY_MODEL is set",
  )
  .action(
    withErrorHandler(
      async (
        model: string,
        options: {
          fileId: string[];
          operationId?: string;
          forceTranscribe?: boolean;
        },
      ) => {
        if (model !== VOICE_TRANSCRIPTION_MODEL)
          throw new Error(`Supported model: ${VOICE_TRANSCRIPTION_MODEL}`);
        if (!options.forceTranscribe && getOkouAntigravityModel()?.trim()) {
          const paths = await downloadVoiceClipsForNativeAudio(options.fileId);
          process.stdout.write(formatNativeAudioPrompt(paths));
          return;
        }
        const result = await initClient(
          transcribeContract,
          await getClientConfig(),
        ).transcribe({
          body: {
            model,
            fileIds: options.fileId,
            operationId: options.operationId,
          },
        });
        if (result.status !== 200) handleError(result, "Transcription failed");
        const path = join(tmpdir(), `okou-transcribe-${randomUUID()}.txt`);
        await writeFile(path, result.body.transcript, {
          flag: "wx",
          mode: 0o600,
        });
        console.error(path);
        process.stdout.write(result.body.transcript);
      },
    ),
  );
