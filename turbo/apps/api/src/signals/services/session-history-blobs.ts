import {
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
} from "@okouai/api-contracts/contracts/runners";

export {
  SESSION_HISTORY_ENCODING_GZIP,
  SESSION_HISTORY_ENCODING_IDENTITY,
  SESSION_HISTORY_ENCODING_ZSTD,
};

export type SessionHistoryBlobEncoding =
  | typeof SESSION_HISTORY_ENCODING_IDENTITY
  | typeof SESSION_HISTORY_ENCODING_GZIP
  | typeof SESSION_HISTORY_ENCODING_ZSTD;

export function tryNormalizeSessionHistoryBlobEncoding(
  encoding: string | null,
): SessionHistoryBlobEncoding | undefined {
  if (encoding === null || encoding === SESSION_HISTORY_ENCODING_IDENTITY) {
    return SESSION_HISTORY_ENCODING_IDENTITY;
  }
  if (encoding === SESSION_HISTORY_ENCODING_GZIP) {
    return SESSION_HISTORY_ENCODING_GZIP;
  }
  if (encoding === SESSION_HISTORY_ENCODING_ZSTD) {
    return SESSION_HISTORY_ENCODING_ZSTD;
  }
  return undefined;
}

export function resumeSessionHistoryRawBlobKey(hash: string): string {
  return `blobs/${hash}.blob`;
}

function resumeSessionHistoryGzipBlobKey(hash: string): string {
  return `blobs/${hash}.blob.gz`;
}

function resumeSessionHistoryZstdBlobKey(hash: string): string {
  return `blobs/${hash}.blob.zst`;
}

export function resumeSessionHistoryBlobKey(
  hash: string,
  encoding: SessionHistoryBlobEncoding,
): string {
  switch (encoding) {
    case SESSION_HISTORY_ENCODING_GZIP: {
      return resumeSessionHistoryGzipBlobKey(hash);
    }
    case SESSION_HISTORY_ENCODING_ZSTD: {
      return resumeSessionHistoryZstdBlobKey(hash);
    }
    case SESSION_HISTORY_ENCODING_IDENTITY: {
      return resumeSessionHistoryRawBlobKey(hash);
    }
  }
}
