import { command } from "ccstate";
import {
  prepareWorkflowAttachmentBundle,
  workflowAttachmentMetadata,
} from "@okouai/core/workflow-attachment-bundle";
import type { WorkflowAttachments } from "@okouai/api-contracts/contracts/workflow-attachments";
import { env } from "../../lib/env";
import { putS3Object } from "../external/s3";

/** Stage 1 retains prepared objects; no new-package deletion is activated. */
export const prepareWorkflowAttachments$ = command(
  async (
    { get },
    input: {
      readonly orgId: string;
      readonly workflowId: string;
      readonly files: readonly {
        readonly path: string;
        readonly content: string;
      }[];
      readonly current?: WorkflowAttachments | null;
    },
    signal: AbortSignal,
  ) => {
    const files = input.files.map((file) => {
      return {
        path: file.path,
        content: Buffer.from(file.content, "utf8"),
      };
    });
    const metadata = workflowAttachmentMetadata(files);
    if (input.current?.kind === "empty" && metadata.length === 0) {
      return input.current;
    }
    if (
      input.current?.kind === "bundle" &&
      input.current.objectKey.startsWith(
        `workflow-attachments/${input.orgId}/${input.workflowId}/`,
      ) &&
      JSON.stringify(input.current.files) === JSON.stringify(metadata)
    ) {
      return input.current;
    }
    const prepared = await prepareWorkflowAttachmentBundle(
      input.orgId,
      input.workflowId,
      files,
    );
    signal.throwIfAborted();
    if (prepared.descriptor.kind === "bundle" && prepared.archive !== null) {
      await get(
        putS3Object(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          prepared.descriptor.objectKey,
          prepared.archive,
          "application/gzip",
          signal,
        ),
      );
      signal.throwIfAborted();
    }
    return prepared.descriptor;
  },
);
