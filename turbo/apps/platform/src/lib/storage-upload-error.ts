export interface StorageUploadContext {
  readonly file_id: string;
  readonly file_size: number;
  readonly part_number: number;
  readonly part_count: number;
}

/** Safe observations only: never retain a URL, filename, body or request headers. */
export interface StorageUploadObservation extends StorageUploadContext {
  readonly attempt: number;
  readonly request_event: "error" | "timeout";
  readonly target_origin: string;
  readonly response_status: number;
  readonly ready_state: number;
  /** Browser-reported bytes do not establish that storage received the part. */
  readonly reported_bytes: number;
  readonly total_bytes: number;
  readonly elapsed_ms: number;
  readonly timeout_ms: number;
  readonly online: boolean;
  readonly with_credentials: boolean;
}

export class StorageUploadError extends TypeError {
  constructor(readonly diagnostics: StorageUploadObservation) {
    // Preserve the existing error type and message for callers and Sentry.
    super("Storage upload failed");
  }
}
