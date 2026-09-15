export interface SocialKitDownloadRequestSnapshot {
  readonly platform: "youtube" | "tiktok" | "instagram" | "facebook";
  readonly url: string;
  readonly maxDuration: number;
  readonly quality: "240p" | "360p" | "480p" | "720p" | "1080p";
  readonly format: "mp4" | "m4a";
}

export interface SocialKitDownloadProviderResult {
  readonly durationSeconds: number;
  readonly fileSizeMB: number;
  readonly creditsCost: number;
  // Older jobs did not persist provider-reported media metadata.
  readonly quality?: string;
  readonly format?: "mp4" | "m4a";
  readonly title?: string;
  readonly thumbnail?: string;
}

export interface SocialKitDownloadArtifactResult {
  readonly id: string;
  readonly url: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  // Only byte-sniffed formats are evidence of the delivered file type.
  readonly format?: "mp4" | "m4a" | "mp3" | null;
}

export interface SocialKitDownloadError {
  readonly code: string;
  readonly message: string;
  // Optional because existing snapshots and local artifact errors omit provider advice.
  readonly reason?: string;
  readonly retryAfterSeconds?: number;
  readonly retryable?: boolean;
  readonly resubmitRetryable?: boolean;
  readonly provider?: {
    readonly httpStatus: number;
    readonly errorCode?: string;
    readonly code?: string;
    readonly retryable?: boolean;
  };
}
