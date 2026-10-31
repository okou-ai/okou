import type { RouteEntry } from "../route-entry";
import { chatRelationsRoutes } from "./chat-relations";
import { chatSearchRoutes } from "./chat-search";
import { chatInputStatusRoutes } from "./chat-input-status";
import { chatThreadArtifactRoutes } from "./chat-thread-artifacts";
import { chatThreadCatchUpRoutes } from "./chat-thread-catch-up";
import { chatThreadDetailRoutes } from "./chat-thread-details";
import { chatThreadIndicatorRoutes } from "./chat-thread-indicators";
import { chatThreadMessageReadRoutes } from "./chat-thread-message-reads";
import { chatThreadSnapshotRoutes } from "./chat-thread-snapshots";
import { chatThreadActivitySummaryRoutes } from "./chat-threads-activity-summary";
import { chatThreadArchiveRoutes } from "./chat-threads-archive";
import { chatThreadsArtifactsSyncRoutes } from "./chat-threads-artifacts-sync";
import { chatThreadComputerUseHostRoutes } from "./chat-threads-computer-use-host";
import { chatThreadConnectorSelectionRoutes } from "./chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "./chat-threads-create";
import { chatThreadDeleteRoutes } from "./chat-threads-delete";
import { chatThreadDraftGetRoutes } from "./chat-threads-draft-get";
import { chatThreadGetRoutes } from "./chat-threads-get";
import { chatThreadMarkAgentReadRoutes } from "./chat-threads-mark-agent-read";
import { chatThreadMarkReadRoutes } from "./chat-threads-mark-read";
import { chatThreadMarkUnreadRoutes } from "./chat-threads-mark-unread";
import { chatThreadModelSelectionRoutes } from "./chat-threads-model-selection";
import { chatThreadMuteRoutes } from "./chat-threads-mute";
import { chatThreadPatchRoutes } from "./chat-threads-patch";
import { chatThreadPinRoutes } from "./chat-threads-pin";
import { chatThreadPinOrderRoutes } from "./chat-threads-pin-order";
import { chatThreadRenameRoutes } from "./chat-threads-rename";
import { chatThreadUnpinRoutes } from "./chat-threads-unpin";
import { chatThreadUsageRoutes } from "./chat-threads-usage";

export const chatThreadRoutes: readonly RouteEntry[] = [
  ...chatRelationsRoutes,
  ...chatThreadIndicatorRoutes,
  ...chatThreadSnapshotRoutes,
  ...chatThreadDetailRoutes,
  ...chatThreadArtifactRoutes,
  ...chatThreadCatchUpRoutes,
  ...chatThreadMessageReadRoutes,
  ...chatSearchRoutes,
  ...chatThreadUsageRoutes,
  ...chatThreadActivitySummaryRoutes,
  ...chatInputStatusRoutes,
  ...chatThreadArchiveRoutes,
  ...chatThreadMuteRoutes,
  ...chatThreadsArtifactsSyncRoutes,
  ...chatThreadComputerUseHostRoutes,
  ...chatThreadConnectorSelectionRoutes,
  ...chatThreadCreateRoutes,
  ...chatThreadDeleteRoutes,
  ...chatThreadDraftGetRoutes,
  ...chatThreadGetRoutes,
  ...chatThreadMarkAgentReadRoutes,
  ...chatThreadMarkReadRoutes,
  ...chatThreadMarkUnreadRoutes,
  ...chatThreadModelSelectionRoutes,
  ...chatThreadPatchRoutes,
  ...chatThreadPinRoutes,
  ...chatThreadPinOrderRoutes,
  ...chatThreadRenameRoutes,
  ...chatThreadUnpinRoutes,
];
