import type { ReasoningEffort } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import type { ModelSettings } from "./chat-model-settings";

export interface ChatThreadSnapshotProjection {
  readonly id: string;
  readonly agentId: string;
  readonly title: string | null;
  readonly sortAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt: string | null;
  /** Absent in snapshots compacted before manual pin ordering. */
  readonly pinOrder?: string | null;
  readonly renamedAt: string | null;
  /** Absent in snapshots created before effort selection. */
  readonly reasoningEffort?: ReasoningEffort | null;
  readonly selectedModel: string | null;
  /** Absent in snapshots compacted before model-aware settings. */
  readonly modelSettings?: ModelSettings;
  readonly serviceTier: "priority" | null;
  readonly computerUseHostId: string | null;
  readonly cloudBrowserEnabled: boolean;
  readonly selectedVideoModel: string | null;
  readonly selectedImageModel: string | null;
}

export type ChatThreadSnapshotProjections = ChatThreadSnapshotProjection[];
