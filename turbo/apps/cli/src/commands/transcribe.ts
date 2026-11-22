import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { transcribeContract } from "@okouai/api-contracts/contracts/transcribe";
import { initClient } from "@okouai/api-contracts/contracts/trpc-contract";
import { VOICE_TRANSCRIPTION_MODEL } from "@okouai/api-contracts/contracts/voice-clips";
import { getClientConfig, handleError } from "../lib/api/core/client-factory";
import { withErrorHandler } from "../lib/command/with-error-handler";

export const transcribeCommand = new Command("transcribe")
  .description(
    "Transcribe audio in order. Writes UTF-8 text to stdout and a temporary file; prints its path on stderr. Uses model credits.",
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
  .action(
    withErrorHandler(
      async (
        model: string,
        options: { fileId: string[]; operationId?: string },
      ) => {
        if (model !== VOICE_TRANSCRIPTION_MODEL)
          throw new Error(`Supported model: ${VOICE_TRANSCRIPTION_MODEL}`);
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
