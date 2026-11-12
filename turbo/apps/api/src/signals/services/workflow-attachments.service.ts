import { publishContentBundle$ } from "./content-bundle.service";
import { synthesizeWorkflowSkillMd } from "@okouai/core/skill-document";
import {
  contentBundleKey,
  type ContentBundleFile,
} from "@okouai/core/content-bundle";
import {
  isStaffCopiedAttachment,
  readStaffCopiedAttachments,
} from "@okouai/core/staff-single-agent-migration";
import type { ContentBundle } from "@okouai/api-contracts/contracts/content-bundle";
import { command, computed } from "ccstate";
import {
  prepareWorkflowAttachmentBundle,
  normalizeWorkflowAttachmentFiles,
  workflowAttachmentMetadata,
  verifyWorkflowAttachmentBundle,
} from "@okouai/core/workflow-attachment-bundle";
import {
  workflowAttachmentsSchema,
  type WorkflowAttachments,
} from "@okouai/api-contracts/contracts/workflow-attachments";
import { backgroundJobs } from "@okouai/db/schema/background-job";
import { env } from "../../lib/env";
import { writeDb$ } from "../external/db";
import {
  abortMultipartS3Upload,
  completeMultipartS3Upload,
  createMultipartS3Upload,
  downloadS3Buffer,
  downloadS3BufferWithMaxBytes$,
  uploadMultipartS3Part,
} from "../external/s3";
import { settle } from "../utils";
import {
  assertWorkflowAttachmentOwner,
  workflowAttachmentCleanupValues,
} from "./workflow-attachment-cleanup.service";

export interface PreparedWorkflowAttachments {
  readonly attachments: WorkflowAttachments;
  readonly cleanupJobId: string | null;
}

/** Only attachment preparation/provider failures; database publication is separate. */
export class WorkflowAttachmentError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Workflow attachments could not be prepared or uploaded",
      { cause },
    );
    this.name = "WorkflowAttachmentError";
  }
}

/** Authorize the Workflow before supplying its captured descriptor here. */
export function workflowAttachmentFiles(input: {
  readonly orgId: string;
  readonly workflowId: string;
  readonly attachments: WorkflowAttachments | null;
  readonly contentBundle?: ContentBundle | null;
}) {
  return computed(async (get) => {
    if (input.attachments === null) {
      throw new Error("Workflow attachments have not been migrated");
    }
    const descriptor = workflowAttachmentsSchema.parse(input.attachments);
    if (descriptor.kind === "empty") {
      return [];
    }
    if (
      isStaffCopiedAttachment({ ...input, objectKey: descriptor.objectKey })
    ) {
      if (!input.contentBundle) {
        throw new Error("Copied Workflow has no immutable content");
      }
      const archive = await get(
        downloadS3Buffer(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          contentBundleKey(input.contentBundle.sha256),
        ),
      );
      const files = readStaffCopiedAttachments(
        archive,
        input.contentBundle,
        descriptor,
      );
      return files.map((file) => {
        return {
          path: file.path,
          content: file.content.toString("utf8"),
          size: file.content.length,
        };
      });
    }
    assertWorkflowAttachmentOwner(
      input.orgId,
      input.workflowId,
      descriptor.objectKey,
    );
    const downloaded = await settle(
      get(
        downloadS3Buffer(
          env("R2_USER_STORAGES_BUCKET_NAME"),
          descriptor.objectKey,
        ),
      ),
    );
    if (!downloaded.ok) {
      if (
        downloaded.error instanceof Error &&
        ["NoSuchKey", "NotFound"].includes(downloaded.error.name)
      ) {
        throw new Error("Workflow attachment source is unavailable");
      }
      throw downloaded.error;
    }
    const archive = downloaded.value;
    return verifyWorkflowAttachmentBundle(archive, descriptor).map((file) => {
      return {
        path: file.path,
        content: file.content.toString("utf8"),
        size: file.content.length,
      };
    });
  });
}

/** Register exact durable cleanup before any multipart body can be uploaded. */
export const prepareWorkflowAttachments$ = command(
  async (
    { get, set },
    input: {
      readonly orgId: string;
      readonly workflowId: string;
      readonly userId: string;
      readonly files: readonly {
        readonly path: string;
        readonly content: string;
      }[];
      readonly current?: WorkflowAttachments | null;
    },
    signal: AbortSignal,
  ): Promise<PreparedWorkflowAttachments> => {
    const files = input.files.map((file) => {
      return {
        path: file.path,
        content: Buffer.from(file.content, "utf8"),
      };
    });
    const metadata = workflowAttachmentMetadata(files);
    if (input.current?.kind === "empty" && metadata.length === 0) {
      return { attachments: input.current, cleanupJobId: null };
    }
    if (
      input.current?.kind === "bundle" &&
      input.current.objectKey.startsWith(
        `workflow-attachments/${input.orgId}/${input.workflowId}/`,
      ) &&
      JSON.stringify(input.current.files) === JSON.stringify(metadata)
    ) {
      return { attachments: input.current, cleanupJobId: null };
    }
    const preparation = await settle(
      prepareWorkflowAttachmentBundle(input.orgId, input.workflowId, files),
      signal,
    );
    if (!preparation.ok) {
      throw new WorkflowAttachmentError(preparation.error);
    }
    const prepared = preparation.value;
    if (prepared.descriptor.kind === "bundle" && prepared.archive !== null) {
      const bucket = env("R2_USER_STORAGES_BUCKET_NAME");
      const objectKey = prepared.descriptor.objectKey;
      const upload = await settle(
        get(
          createMultipartS3Upload(
            bucket,
            objectKey,
            "application/gzip",
            undefined,
            signal,
          ),
        ),
        signal,
      );
      if (!upload.ok) {
        throw new WorkflowAttachmentError(upload.error);
      }
      const uploadId = upload.value;
      const job = workflowAttachmentCleanupValues({
        orgId: input.orgId,
        userId: input.userId,
        workflowId: input.workflowId,
        objectKey,
        uploadId,
      });
      const registered = await settle(
        set(writeDb$).insert(backgroundJobs).values(job),
        signal,
      );
      if (!registered.ok) {
        // No body has been sent. A lost registration receipt still leaves a
        // durable target; aborting this exact empty upload cannot affect peers.
        await settle(
          get(
            abortMultipartS3Upload(
              bucket,
              objectKey,
              uploadId,
              AbortSignal.timeout(15_000),
            ),
          ),
        );
        signal.throwIfAborted();
        throw registered.error;
      }
      signal.throwIfAborted();
      const part = await settle(
        get(
          uploadMultipartS3Part(
            {
              bucket,
              key: objectKey,
              uploadId,
              partNumber: 1,
              body: prepared.archive,
            },
            signal,
          ),
        ),
        signal,
      );
      if (!part.ok) {
        throw new WorkflowAttachmentError(part.error);
      }
      const completion = await settle(
        get(
          completeMultipartS3Upload(
            bucket,
            objectKey,
            uploadId,
            [part.value],
            signal,
          ),
        ),
        signal,
      );
      if (!completion.ok) {
        throw new WorkflowAttachmentError(completion.error);
      }
      return { attachments: prepared.descriptor, cleanupJobId: job.id };
    }
    return { attachments: prepared.descriptor, cleanupJobId: null };
  },
);

/** Shadow complete bundle: the legacy attachment descriptor remains independently valid. */
export const publishWorkflowContentBundle$ = command(
  async (
    { set },
    input: {
      readonly orgId: string;
      readonly workflowId: string;
      readonly name: string;
      readonly description: string | null;
      readonly instruction: string | null;
      readonly attachments: WorkflowAttachments;
      readonly contentBundle?: ContentBundle | null;
      readonly files?: readonly {
        readonly path: string;
        readonly content: string;
      }[];
    },
    signal: AbortSignal,
  ) => {
    let files: readonly ContentBundleFile[];
    if (input.files !== undefined) {
      files = normalizeWorkflowAttachmentFiles(
        input.files.map((file) => {
          return {
            path: file.path,
            content: Buffer.from(file.content, "utf8"),
          };
        }),
      );
    } else if (input.attachments.kind === "empty") {
      files = [];
    } else if (
      isStaffCopiedAttachment({
        ...input,
        objectKey: input.attachments.objectKey,
      })
    ) {
      if (!input.contentBundle) {
        throw new Error("Copied Workflow has no immutable content");
      }
      const archive = await set(
        downloadS3BufferWithMaxBytes$,
        {
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          key: contentBundleKey(input.contentBundle.sha256),
          maxBytes: input.contentBundle.archiveBytes,
        },
        signal,
      );
      files = readStaffCopiedAttachments(
        archive,
        input.contentBundle,
        input.attachments,
      );
    } else {
      assertWorkflowAttachmentOwner(
        input.orgId,
        input.workflowId,
        input.attachments.objectKey,
      );
      const archive = await set(
        downloadS3BufferWithMaxBytes$,
        {
          bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
          key: input.attachments.objectKey,
          maxBytes: 32 * 1024 * 1024,
        },
        signal,
      );
      signal.throwIfAborted();
      files = verifyWorkflowAttachmentBundle(archive, input.attachments);
    }
    signal.throwIfAborted();
    return await set(
      publishContentBundle$,
      [
        {
          path: "SKILL.md",
          content: Buffer.from(synthesizeWorkflowSkillMd(input), "utf8"),
        },
        ...files,
      ],
      signal,
    );
  },
);
