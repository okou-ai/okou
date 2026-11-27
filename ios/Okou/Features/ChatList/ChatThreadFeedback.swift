import CCStateSwiftUI
import SwiftUI

/// A failure can be retried on its source page. An Undo belongs to one visit to that page.
struct ArchiveFeedbackVisit: Equatable {
  enum Page: Equatable {
    case list(ChatListFilter)
    case chat(String?)
    case forYou
  }

  let id: UUID
  let page: Page

  @MainActor init(_ workspace: WorkspaceStore) {
    let sidebar = workspace.sidebarInteraction
    id = sidebar.visit
    if sidebar.isOpen {
      page = .list(workspace.sidebar.filter)
    } else if sidebar.showsChat {
      page = .chat(workspace.selectedThreadID)
    } else {
      page = .forYou
    }
  }
}

struct ChatThreadFeedback: Identifiable {
  enum Kind: Equatable {
    case operation, error, confirmation
  }

  let id = UUID()
  let threadID: String
  let message: String
  let actionTitle: String?
  let actionHint: String
  let persists: Bool
  var requiresNavigation: Bool
  /// The action targets a chat its own pending change hides from the list (a delete retry).
  let actsOnHiddenChat: Bool
  let isWorking: Bool
  let kind: Kind
  let archiveVisit: ArchiveFeedbackVisit?
  let action: @MainActor () async -> Void

  init(
    threadID: String, message: String, actionTitle: String?, actionHint: String = "",
    persists: Bool = false, requiresNavigation: Bool = false, actsOnHiddenChat: Bool = false,
    isWorking: Bool = false, kind: Kind = .operation, archiveVisit: ArchiveFeedbackVisit? = nil,
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
    self.archiveVisit = archiveVisit
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
      showsDismiss: feedback.kind != .confirmation,
      autoDismissAfter: feedback.persists ? nil : .seconds(6),
      action: {
        Task { await store.navigationActions.performThreadFeedback(feedback.id) }
      },
      dismiss: {
        store.dismissThreadFeedback(feedback.id)
      }
    )
  }
}
