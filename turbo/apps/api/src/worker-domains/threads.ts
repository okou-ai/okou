import { createAppWithRoutes } from "../app-factory-runtime";
import { createWorkerHandler } from "../worker-runtime";
import type { RouteEntry } from "../signals/route-entry";
import { chatRelationsRoutes } from "../signals/routes/chat-relations";
import { chatThreadIndicatorRoutes } from "../signals/routes/chat-thread-indicators";
import { chatThreadSnapshotRoutes } from "../signals/routes/chat-thread-snapshots";
import { chatThreadDetailRoutes } from "../signals/routes/chat-thread-details";
import { chatThreadArtifactRoutes } from "../signals/routes/chat-thread-artifacts";
import { chatThreadMessageReadRoutes } from "../signals/routes/chat-thread-message-reads";
import { chatThreadUsageRoutes } from "../signals/routes/chat-threads-usage";
import { chatThreadActivitySummaryRoutes } from "../signals/routes/chat-threads-activity-summary";
import { chatThreadArchiveRoutes } from "../signals/routes/chat-threads-archive";
import { chatThreadMuteRoutes } from "../signals/routes/chat-threads-mute";
import { chatThreadsArtifactsSyncRoutes } from "../signals/routes/chat-threads-artifacts-sync";
import { chatThreadComputerUseHostRoutes } from "../signals/routes/chat-threads-computer-use-host";
import { chatThreadConnectorSelectionRoutes } from "../signals/routes/chat-threads-connector-selections";
import { chatThreadCreateRoutes } from "../signals/routes/chat-threads-create";
import { chatThreadDeleteRoutes } from "../signals/routes/chat-threads-delete";
import { chatThreadDraftGetRoutes } from "../signals/routes/chat-threads-draft-get";
import { chatThreadGetRoutes } from "../signals/routes/chat-threads-get";
import { chatThreadMarkAgentReadRoutes } from "../signals/routes/chat-threads-mark-agent-read";
import { chatThreadMarkReadRoutes } from "../signals/routes/chat-threads-mark-read";
import { chatThreadMarkUnreadRoutes } from "../signals/routes/chat-threads-mark-unread";
import { chatThreadModelSelectionRoutes } from "../signals/routes/chat-threads-model-selection";
import { chatThreadPatchRoutes } from "../signals/routes/chat-threads-patch";
import { chatThreadPinRoutes } from "../signals/routes/chat-threads-pin";
import { chatThreadPinOrderRoutes } from "../signals/routes/chat-threads-pin-order";
import { chatThreadRenameRoutes } from "../signals/routes/chat-threads-rename";
import { chatThreadUnpinRoutes } from "../signals/routes/chat-threads-unpin";
import { welcomeChatThreadRoutes } from "../signals/routes/welcome-chat-threads";
import { sharedThreadRoutes } from "../signals/routes/shared-threads";
import { configureChatRunFinishedEventDispatcher$ } from "../signals/services/chat-run-finished-event-registration.service";

const roleRoutes: readonly RouteEntry[] = [
  ...chatRelationsRoutes,
  ...chatThreadIndicatorRoutes,
  ...chatThreadSnapshotRoutes,
  ...chatThreadDetailRoutes,
  ...chatThreadArtifactRoutes,
  ...chatThreadMessageReadRoutes,
  ...chatThreadUsageRoutes,
  ...chatThreadActivitySummaryRoutes,
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
  ...welcomeChatThreadRoutes,
  ...sharedThreadRoutes,
];

export default createWorkerHandler((signal) => {
  return createAppWithRoutes({
    signal,
    routes: roleRoutes,
    initializeServices$: configureChatRunFinishedEventDispatcher$,
  });
});
