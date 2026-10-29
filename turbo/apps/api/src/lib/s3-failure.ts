import { singleton } from "./singleton";
import { onRejection } from "../signals/utils";

type S3Command =
  | "AbortMultipartUpload"
  | "CompleteMultipartUpload"
  | "CopyObject"
  | "CreateMultipartUpload"
  | "DeleteObjects"
  | "GetObject"
  | "HeadObject"
  | "ListMultipartUploads"
  | "ListObjectsV2"
  | "ListParts"
  | "PutObject"
  | "UploadPart";

interface S3FailureContext {
  readonly command?: S3Command;
  readonly execution?: "request" | "presign";
  readonly operationOutcome?: "read_failed" | "mutation_outcome_unknown";
  readonly storagePhase?: "artifact_registration";
  readonly apiPhase?:
    | "resolve_web_file"
    | "resolve_artifact_reference"
    | "download_artifact"
    | "allocate_upload"
    | "create_multipart_upload"
    | "sign_upload_parts"
    | "sign_upload"
    | "verify_deployment_files"
    | "complete_deployment_preview"
    | "publish_deployment_manifest"
    | "promote_deployment"
    | "record_deployment_artifact";
  readonly completedSteps?: readonly (
    | "artifact_allocation"
    | "multipart_creation"
    | "manifest_write"
    | "deployment_promotion"
  )[];
  /** Describes only this completion, not earlier or concurrent publications. */
  readonly publicationThisAttempt?: "not_started" | "unknown" | "acknowledged";
  readonly deploymentStatusBeforeAttempt?: "uploading" | "ready";
}

// Do not mutate SDK errors (which may be frozen), copy provider inputs, or put
// phase state on a shared client. Context follows the original thrown object.
const failures = singleton(() => {
  return new WeakMap<object, S3FailureContext>();
});

/** Enrich a failure at its owning boundary without changing its identity. */
export function retainS3FailureContext<T>(
  work: Promise<T>,
  context: S3FailureContext,
): Promise<T> {
  return onRejection(work, (error) => {
    if (typeof error === "object" && error !== null) {
      failures().set(error, { ...failures().get(error), ...context });
    }
  });
}

export function s3Request<T>(command: S3Command, work: Promise<T>): Promise<T> {
  const read =
    command === "GetObject" ||
    command === "HeadObject" ||
    command === "ListMultipartUploads" ||
    command === "ListObjectsV2" ||
    command === "ListParts";
  return retainS3FailureContext(work, {
    command,
    execution: "request",
    operationOutcome: read ? "read_failed" : "mutation_outcome_unknown",
  });
}

/** Only explicit context and SDK metadata/status can reach reporting sinks. */
export function s3FailureDiagnostics(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const context = failures.peek()?.get(error);
  if (!context?.command) {
    return undefined;
  }
  const candidate = error as {
    readonly $metadata?: {
      readonly httpStatusCode?: unknown;
      readonly attempts?: unknown;
      readonly totalRetryDelay?: unknown;
      readonly requestId?: unknown;
    };
    readonly $response?: { readonly statusCode?: unknown };
  };
  const metadata = candidate.$metadata;
  const metadataStatus = metadata?.httpStatusCode;
  const responseStatus = candidate.$response?.statusCode;
  return {
    ...context,
    ...(typeof metadataStatus === "number"
      ? { httpStatus: metadataStatus, httpStatusSource: "sdk_metadata" }
      : typeof responseStatus === "number"
        ? { httpStatus: responseStatus, httpStatusSource: "sdk_response" }
        : {}),
    ...(typeof metadata?.attempts === "number"
      ? { attempts: metadata.attempts }
      : {}),
    ...(typeof metadata?.totalRetryDelay === "number"
      ? { retryDelayMs: metadata.totalRetryDelay }
      : {}),
    ...(typeof metadata?.requestId === "string"
      ? { providerRequestId: metadata.requestId }
      : {}),
  };
}
