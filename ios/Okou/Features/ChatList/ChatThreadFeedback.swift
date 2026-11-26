import CCStateSwiftUI
import SwiftUI

struct ChatThreadFeedback: Identifiable {
  enum Kind {
    case operation, error
  }

  let id = UUID()
  let threadID: String
  let message: String
  let actionTitle: String?
  let actionHint: String
  let persists: Bool
  let requiresNavigation: Bool
  /// The action targets a chat its own pending change hides from the list (a delete retry).
  let actsOnHiddenChat: Bool
  let isWorking: Bool
  let kind: Kind
  let action: @MainActor () async -> Void

  init(
    threadID: String, message: String, actionTitle: String?, actionHint: String = "",
    persists: Bool = false, requiresNavigation: Bool = false, actsOnHiddenChat: Bool = false,
    isWorking: Bool = false, kind: Kind = .operation,
    action: @escaping @MainActor () async -> Void
  ) {
    self.threadID = threadID
    self.message = message
    self.actionTitle = actionTitle
    self.actionHint = actionHint
    self.persists = persists
    self.requiresNavigation = requiresNavigation
    self.actsOnHiddenChat = actsOnHiddenChat
    self.isWorking = isWorking
    self.kind = kind
    self.action = action
  }
}

struct ChatThreadFeedbackView: View {
  let store: WorkspaceStore
  let feedback: ChatThreadFeedback
  /// The chat list's status and row mutations and the workspace's status, kept in the workspace
  /// session's Store, so a mark-all-read, a chat write, an update requirement or a new chat
  /// being created updates whether the action applies.
  @ResolvedValue private var listStatus: ThreadListStore.Status?
  @ResolvedValue private var mutations: ThreadListMutations.Activity?
  @ResolvedValue private var actionStatus: WorkspaceStore.ActionStatus?

  init(store: WorkspaceStore, feedback: ChatThreadFeedback) {
    self.store = store
    self.feedback = feedback
    _listStatus = ResolvedValue(store.list.statusValue)
    _mutations = ResolvedValue(store.list.mutationsValue)
    _actionStatus = ResolvedValue(store.actionStatusValue)
  }

  var body: some View {
    let markingAllRead = (listStatus ?? store.list.status).markingAllRead
    let activity = mutations ?? store.list.mutations
    let workspace = actionStatus ?? store.actionStatus
    ChatFeedbackSurface(
      message: feedback.message,
      icon: feedback.kind == .error ? "circle-alert" : "circle-check",
      isWorking: feedback.isWorking,
      actionTitle: feedback.actionTitle,
      actionEnabled: !markingAllRead
        && (feedback.actsOnHiddenChat
          ? store.list.canWrite(feedback.threadID, mutations: activity)
          : store.list.canUpdate(feedback.threadID, mutations: activity))
        && !workspace.needsUpgrade
        && (!feedback.requiresNavigation || !workspace.isCreating),
      actionHint: feedback.actionHint,
      autoDismissAfter: feedback.persists ? nil : .seconds(6),
      action: {
        store.dismissThreadFeedback(feedback.id)
        Task { await feedback.action() }
      },
      dismiss: {
        store.dismissThreadFeedback(feedback.id)
      }
    )
  }
}
