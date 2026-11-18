import type { FileEntryWithHash } from "@okouai/api-contracts/contracts/storage-content-hash";
import type { SandboxAuth } from "../../types/auth";
import type { badRequestMessage, conflict, notFound } from "../../lib/error";
import type {
  memberMemoryStorageRecord,
  memberMemoryVersionRecord,
} from "./member-memory-records";

// DTOs for the retained callback protocol; backed by member Memory.
export interface CommitStorageUploadInput {
  readonly versionId: string;
  readonly files: readonly FileEntryWithHash[];
  readonly runId?: string;
  readonly parentVersionId?: string;
  readonly message?: string;
}

export interface CommitStorageForStorageInput extends CommitStorageUploadInput {
  readonly storageId: string;
  readonly sandboxAuth: SandboxAuth;
}

export type StorageRow = ReturnType<typeof memberMemoryStorageRecord>;
export type StorageVersionRow = ReturnType<typeof memberMemoryVersionRecord>;

export type StorageErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | {
      readonly status: 413;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "PAYLOAD_TOO_LARGE";
        };
      };
    }
  | {
      readonly status: 500;
      readonly body: {
        readonly error: {
          readonly message: string;
          readonly code: "INTERNAL_ERROR";
        };
      };
    };

export type CommitStorageResponse =
  | {
      readonly status: 200;
      readonly body: {
        readonly success: true;
        readonly versionId: string;
        readonly storageName: string;
        readonly size: number;
        readonly fileCount: number;
        readonly deduplicated?: boolean;
      };
    }
  | StorageErrorResponse
  | ReturnType<typeof conflict>;

export interface VerifiedStorageCommit {
  readonly archiveSize: number;
  readonly s3Key: string;
}
