export interface ChatTeamsFileTokenPayload {
  readonly tenantId: string;
  readonly url: string;
  readonly downloadMode?: "graph";
  readonly id?: string;
  readonly name?: string;
  readonly contentType?: string;
}

/** Teams file descriptor retained as server-private launch material. */
export interface ChatTeamsMessageFile {
  readonly fileId: string;
  readonly sourceId?: string;
  readonly name: string;
  readonly contentType: string;
  readonly inCurrentMessage: boolean;
  readonly payload: ChatTeamsFileTokenPayload;
  /** Ready copy imported at admission; older queued contexts retain native downloads. */
  readonly canonicalAsset?: {
    readonly assetId: string;
    readonly filename: string;
    readonly contentType: string;
  };
}

export type ChatTeamsMessageFiles = readonly ChatTeamsMessageFile[];
