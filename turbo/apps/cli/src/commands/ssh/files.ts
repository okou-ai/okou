import { Command } from "commander";
import { z } from "zod";
import { withErrorHandler } from "../../lib/command/with-error-handler";
import {
  DownloadDestination,
  UploadSource,
  fileReason,
  validateFilePath,
} from "./file-local";
import {
  FILE_LIMIT_HELP,
  failure,
  type Direction,
  type FileOutcome,
  type FileReason,
} from "./file-protocol";
import { transferFile } from "./file-rpc";

function guidance(reason: FileReason | null) {
  switch (reason) {
    case "file_too_large":
      return "Split the file into pieces of at most 1 GiB before transferring.";
    case "timed_out":
      return "Use smaller files or a faster connection; the 15-minute total deadline does not reset per chunk.";
    case "transfer_limit":
      return "Wait for another transfer to finish; uploads and downloads share 2 slots per Run.";
    case "destination_exists":
      return "Choose another destination, or use --overwrite only when replacement is intended.";
    case "path_not_found":
      return "Check the source and create the destination parent directory first.";
    case "not_regular_file":
      return "Choose a regular file, not a directory, device, or final symlink.";
    case "permission_denied":
      return "Check file and parent-directory permissions for the configured SSH user.";
    case "source_changed":
      return "Keep the source unchanged while transferring, then inspect the destination before retrying.";
    case "unsupported_operation":
    case "subsystem_unavailable":
      return "Use a Run with SSH file-transfer support. The server must support SFTP v3 and hardlink@openssh.com (default) or posix-rename@openssh.com (--overwrite); there is no shell/scp fallback.";
    case "helper_unavailable":
      return "Start a new Run with the packaged SSH file-transfer helper.";
    case "invalid_path":
      return "Use a literal file path of 1–4096 UTF-8 bytes; no trailing slash, NUL, . or .. filename.";
    default:
      return "Check SSH access, host configuration, local storage and server permissions before retrying.";
  }
}

function printResult(result: FileOutcome, json: boolean) {
  const next = guidance(result.failure_reason);
  if (json)
    console.log(
      JSON.stringify({
        ...result,
        guidance: result.type === "failed" ? next : null,
      }),
    );
  else if (result.type === "completed")
    console.log(
      `${result.direction === "upload" ? "Uploaded" : "Downloaded"} ${result.bytes} bytes; SHA-256 ${result.sha256}.`,
    );
  else
    console.error(
      `SSH ${result.direction} failed: ${result.failure_reason}; effects=${result.effects}. ${next}`,
    );
  if (!json && result.effects === "unknown")
    console.error(
      "The remote destination may have changed. Inspect it before retrying; do not automatically replay this transfer.",
    );
  if (!json && result.residue)
    console.error(
      `Temporary staging may remain: ${JSON.stringify(result.residue)}. Inspect it before removing it.`,
    );
  process.exitCode = result.type === "completed" ? 0 : 1;
}

export function createFileCommand(
  direction: Direction,
  requireCapability: () => void,
) {
  return new Command(direction)
    .description(
      `${direction === "upload" ? "Upload" : "Download"} one regular file through Runner-owned SFTP`,
    )
    .argument("<connection-id>", "Exact ID from okou ssh host list")
    .argument(
      direction === "upload" ? "<local-file>" : "<remote-file>",
      "Literal source file path",
    )
    .argument(
      direction === "upload" ? "<remote-file>" : "<local-file>",
      "Literal destination file path; parent must exist",
    )
    .option(
      "--overwrite",
      "Atomically replace an existing regular destination file",
    )
    .option(
      "--json",
      "Print outcome, SHA-256, failure_reason, effects, residue and limits as JSON",
    )
    .addHelpText(
      "after",
      `\n${FILE_LIMIT_HELP}\nPaths are literal: no shell expansion, recursion, resume or automatic parent-directory creation. Default: no overwrite. No automatic retry after an uncertain result.\n`,
    )
    .action(
      withErrorHandler(
        async (
          connectionId: string,
          first: string,
          second: string,
          options: { overwrite?: boolean; json?: boolean },
        ) => {
          requireCapability();
          if (!z.uuid().safeParse(connectionId).success)
            throw new Error(
              "Invalid SSH connection ID. Use an exact ID from okou ssh host list.",
            );
          const localPath = direction === "upload" ? first : second;
          const remotePath = direction === "upload" ? second : first;
          const source =
            direction === "upload" ? new UploadSource() : undefined;
          const destination =
            direction === "download"
              ? new DownloadDestination(localPath, options.overwrite === true)
              : undefined;
          let result: FileOutcome;
          try {
            validateFilePath(remotePath);
            await source?.init(localPath);
            await destination?.init();
            result = await transferFile({
              direction,
              connectionId,
              remotePath,
              overwrite: options.overwrite === true,
              source,
              destination,
            });
          } catch (error) {
            result = failure(direction, connectionId, fileReason(error));
            result.actual_bytes = source?.size ?? null;
          }
          // Cleanup is an owned part of the operation. A published file stays
          // completed even if removing its private staging directory fails.
          try {
            await Promise.all([source?.close(), destination?.close()]);
          } catch {
            // Preserve the primary outcome. Destination cleanup keeps residue
            // populated until its acknowledged removal; never hide that path.
          }
          if (destination) result.residue = destination.residue;
          printResult(result, options.json === true);
        },
      ),
    );
}
