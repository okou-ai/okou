import ChatData
import ChatDomain
import Foundation
import Observation

/// Workspace navigation and action feedback survive temporary presentation changes.
@MainActor @Observable
final class WorkspaceChatActions {
  private weak var workspace: WorkspaceStore?
  private let client: APIClient
  private let sync: ChatSync
  private let commands: ChatCommands
  private let lifecycleTasks: LifecycleTasks
  private let handle: @MainActor (Error) -> Void
  private let didSelect: @MainActor (ChatThread) -> Void
  private let didFinishOpening: @MainActor () -> Void
  private let isResident: @MainActor (String) -> Bool
  private var closed = false
  private var needsUpgrade: Bool { workspace?.needsUpgrade ?? true }
  private var chatLinkRequestID = UUID()
  private(set) var openingThreadID: String?
  private(set) var chatLinkError: String?
  private(set) var threadFeedback: ChatThreadFeedback?
  private(set) var fork: ChatForkStore?
  private(set) var threadPreview: ChatThreadPreviewResources?

  init(
    workspace: WorkspaceStore, client: APIClient, sync: ChatSync, commands: ChatCommands,
    lifecycleTasks: LifecycleTasks,
    didSelect: @escaping @MainActor (ChatThread) -> Void,
    didFinishOpening: @escaping @MainActor () -> Void,
    isResident: @escaping @MainActor (String) -> Bool,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.workspace = workspace
    self.client = client
    self.sync = sync
    self.commands = commands
    self.lifecycleTasks = lifecycleTasks
    self.didSelect = didSelect
    self.didFinishOpening = didFinishOpening
    self.isResident = isResident
    handle = didFail
  }

  func cancelOpening() {
    chatLinkRequestID = UUID()
    openingThreadID = nil
  }

  func previewChat(_ id: String) {
    guard let workspace else { return }
    guard !closed, !needsUpgrade, threadPreview?.threadID != id,
      workspace.list.threads.contains(where: { $0.id == id })
    else { return }
    threadPreview?.close()
    // Share serialized history reads without retaining a conversation, draft or realtime work.
    threadPreview = ChatThreadPreviewResources(
      threadID: id, sync: sync,
      didFinish: { [weak self, sync] in
        guard self?.isResident(id) != true else { return }
        _ = await sync.releaseHistory(threadID: id)
      },
      didFail: { [weak self] in self?.handle($0) })
  }

  func dismissChatPreview(_ id: String) {
    guard threadPreview?.threadID == id else { return }
    threadPreview?.close()
    threadPreview = nil
  }

  func selectChat(_ id: String) {
    guard let workspace else { return }
    guard !closed, let thread = workspace.list.threads.first(where: { $0.id == id }) else { return }
    chatLinkRequestID = UUID()
    openingThreadID = nil
    didSelect(thread)
  }

  func dismissChatLinkError() { chatLinkError = nil }

  func openChatLink(_ destination: ChatLinkDestination) async -> Bool {
    guard let workspace else { return false }
    guard !closed, !needsUpgrade, !Task.isCancelled else { return false }
    let requestID = UUID()
    chatLinkRequestID = requestID
    openingThreadID = nil
    chatLinkError = nil
    defer {
      if chatLinkRequestID == requestID {
        openingThreadID = nil
        didFinishOpening()
      }
    }
    func ownsRequest() -> Bool {
      !closed && !needsUpgrade && !Task.isCancelled && chatLinkRequestID == requestID
    }
    do {
      let id: String
      let runID: String?
      switch destination {
      case .thread(let threadID, let sourceRunID):
        id = threadID
        runID = sourceRunID
      case .workflow(let workflowID):
        let threadID = try await client.workflowChatThreadID(workflowID)
        guard ownsRequest() else { return false }
        guard let threadID else {
          chatLinkError = "This workflow's chat is no longer available."
          return false
        }
        id = threadID
        runID = nil
      }
      await workspace.list.restoreCached()
      guard ownsRequest() else { return false }
      if !workspace.list.threads.contains(where: { $0.id == id }) {
        let refreshed = await workspace.list.refresh(waitForCurrent: true)
        guard ownsRequest(), refreshed, workspace.list.error == nil else { return false }
      }
      guard ownsRequest() else { return false }
      // Keep the destination resident while its history resolves the run anchor.
      openingThreadID = id
      guard let conversation = workspace.conversation(for: id) else {
        chatLinkError = "This chat is no longer available in this workspace."
        return false
      }
      didSelect(conversation.thread)
      await conversation.restoreCached()
      guard ownsRequest() else { return false }
      if let runID {
        if !conversation.revealRun(runID) {
          await conversation.refresh(waitForCurrent: true)
          guard ownsRequest() else { return false }
          _ = conversation.revealRun(runID)
        }
      }
      guard ownsRequest() else { return false }
      return true
    } catch is CancellationError {
      return false
    } catch {
      guard ownsRequest() else { return false }
      chatLinkError = error.localizedDescription
      handle(error)
      return false
    }
  }

  func openSearchResult(_ id: String) async -> Bool {
    guard let workspace else { return false }
    guard !closed, !needsUpgrade else { return false }
    let searchID = workspace.search.requestID
    guard workspace.search.ownsPresentation(searchID) else { return false }
    workspace.search.setOpeningError(nil)
    let needsRefresh = !workspace.list.threads.contains(where: { $0.id == id })
    if needsRefresh {
      guard await workspace.list.refresh(waitForCurrent: true) else { return false }
    }
    guard !closed, !Task.isCancelled else { return false }
    guard workspace.search.ownsPresentation(searchID) else { return false }
    guard !needsRefresh || workspace.list.error == nil else { return false }
    guard workspace.list.threads.contains(where: { $0.id == id }) else {
      workspace.search.setOpeningError("This chat is no longer available. Refresh and try again.")
      return false
    }
    // Like the PWA, message hits open the chat at its existing reading position.
    selectChat(id)
    workspace.search.dismiss()
    return true
  }

  func dismissThreadFeedback(_ id: UUID) {
    if threadFeedback?.id == id { threadFeedback = nil }
  }

  @discardableResult
  func moveToProject(
    _ id: String, projectID: String?, didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    guard let workspace else { return false }
    guard !closed, !needsUpgrade else { return false }
    return await workspace.list.setProject(
      id, projectID: projectID,
      onFailure: { [weak self] message in
        guard let self, !closed, !needsUpgrade else { return }
        threadFeedback = ChatThreadFeedback(
          threadID: id, message: message, actionTitle: "Retry", persists: true, kind: .error
        ) { [weak self] in
          await self?.moveToProject(id, projectID: projectID)
        }
      },
      didBegin: {
        if threadFeedback?.threadID == id { threadFeedback = nil }
        if let projectID { workspace.projects.expand(projectID) }
        didBegin()
      })
  }

  @discardableResult
  func setArchived(
    _ id: String, archived: Bool, leaveDetail: Bool = false,
    restoreOnUndo: Bool = false, reopenOnSuccess: Bool = false,
    eventID: String = UUID().uuidString.lowercased()
  ) async -> Bool {
    guard let workspace else { return false }
    guard !closed, !needsUpgrade, workspace.list.canUpdate(id),
      let thread = workspace.list.threads.first(where: { $0.id == id })
    else { return false }
    let leaving = archived && leaveDetail && workspace.selectedThreadID == id
    // Creation already owns the next navigation when its response arrives.
    guard !workspace.isCreating || (!leaving && !reopenOnSuccess) else { return false }
    let restore = leaving || restoreOnUndo
    var failure: String?
    var pendingFeedbackID: UUID?
    let succeeded = await workspace.list.setArchived(
      thread, archived: archived, eventID: eventID, onFailure: { failure = $0 },
      didBegin: {
        // The list owns the write, so leaving the detail cannot cancel it.
        if leaving { self.workspace?.sidebarInteraction.setOpen(true) }
        let pending = ChatThreadFeedback(
          threadID: id,
          message: archived
            ? String(localized: "Archiving chat…") : String(localized: "Unarchiving chat…"),
          actionTitle: nil, persists: true, isWorking: true
        ) {}
        pendingFeedbackID = pending.id
        self.threadFeedback = pending
      })
    guard !closed, !needsUpgrade else { return false }
    if succeeded { workspace.notificationReadStateChanged() }
    // A late acknowledgement must not replace feedback from a newer action or dismissal.
    guard let pendingFeedbackID, threadFeedback?.id == pendingFeedbackID else { return succeeded }
    if succeeded {
      if reopenOnSuccess {
        selectChat(id)
        workspace.sidebarInteraction.setOpen(false)
      }
      threadFeedback = ChatThreadFeedback(
        threadID: id,
        message: archived
          ? String(localized: "Chat archived") : String(localized: "Chat unarchived"),
        actionTitle: String(localized: "Undo"),
        actionHint: restore ? String(localized: "Restores the chat and returns to it.") : "",
        requiresNavigation: restore
      ) { [weak self] in
        guard let self else { return }
        await self.setArchived(id, archived: !archived, reopenOnSuccess: restore)
      }
    } else {
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: failure ?? "The archive change was not confirmed.",
        actionTitle: "Retry", persists: true, requiresNavigation: reopenOnSuccess, kind: .error
      ) { [weak self] in
        await self?.setArchived(
          id, archived: archived, restoreOnUndo: restore,
          reopenOnSuccess: reopenOnSuccess, eventID: eventID)
      }
    }
    return succeeded
  }

  func setMuted(_ id: String, muted: Bool, markRead: Bool = true) async {
    guard let workspace else { return }
    guard !closed, !needsUpgrade, workspace.list.canMute(id) else { return }
    var failure: String?
    let succeeded = await workspace.list.setMuted(
      id, muted: muted, markRead: markRead, onFailure: { failure = $0 })
    guard !closed, !needsUpgrade else { return }
    if succeeded {
      let message =
        muted
        ? "Chat muted"
        : "Chat unmuted"
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: message, actionTitle: "Undo"
      ) { [weak self] in
        // Undo restores mute state without clearing unread replies, like the PWA.
        await self?.setMuted(id, muted: !muted, markRead: false)
      }
    } else {
      threadFeedback = ChatThreadFeedback(
        threadID: id, message: failure ?? "The mute change was not confirmed.",
        actionTitle: "Retry", persists: true, kind: .error
      ) { [weak self] in
        await self?.setMuted(id, muted: muted, markRead: markRead)
      }
    }
  }

  func startFork(_ selection: ChatFeedbackSelection, from conversation: ConversationStore) {
    guard let workspace else { return }
    guard !closed, !needsUpgrade, fork == nil,
      workspace.selectedConversation === conversation, let agentID = workspace.defaultAgentID,
      let message = conversation.messages.first(where: { $0.id == selection.eventID }),
      message.role == .assistant, !message.isError, !message.isQueued,
      message.text.utf16.elementsEqual(selection.text.utf16), let runID = message.runID
    else { return }
    fork = ChatForkStore(
      selection: selection, sourceRunID: runID, projectID: conversation.thread.projectId,
      agentID: agentID, commands: commands, models: workspace.modelStore,
      workflowSource: workspace.composerWorkflows,
      lifecycleTasks: lifecycleTasks,
      didCreate: { [weak self] thread in self?.workspace?.list.insertCreated(thread) },
      didSend: { [weak self] thread in self?.finishFork(thread) },
      didFail: { [weak self] in self?.handle($0) })
  }

  func dismissFork() {
    guard fork?.isSending != true else { return }
    fork?.close()
    fork = nil
  }

  private func finishFork(_ thread: ChatThread) {
    guard let workspace else { return }
    guard !closed else { return }
    dismissFork()
    workspace.requestRefresh(.threadList)
    threadFeedback = ChatThreadFeedback(
      threadID: thread.id, message: String(localized: "New chat created"),
      actionTitle: String(localized: "Open"), requiresNavigation: true,
      action: { [weak self] in self?.selectChat(thread.id) })
  }

  func close() {
    closed = true
    cancelOpening()
    fork?.close()
    fork = nil
    threadPreview?.close()
    threadPreview = nil
    threadFeedback = nil
  }
}

extension WorkspaceStore {
  var chatLinkError: String? { navigationActions.chatLinkError }

  var threadFeedback: ChatThreadFeedback? { navigationActions.threadFeedback }

  var fork: ChatForkStore? { navigationActions.fork }

  var threadPreview: ChatThreadPreviewResources? { navigationActions.threadPreview }

  func previewChat(_ id: String) {
    navigationActions.previewChat(id)
  }

  func dismissChatPreview(_ id: String) {
    navigationActions.dismissChatPreview(id)
  }

  func selectChat(_ id: String) {
    navigationActions.selectChat(id)
  }

  func dismissChatLinkError() {
    navigationActions.dismissChatLinkError()
  }

  func openChatLink(_ destination: ChatLinkDestination) async -> Bool {
    return await navigationActions.openChatLink(destination)
  }

  func openSearchResult(_ id: String) async -> Bool {
    return await navigationActions.openSearchResult(id)
  }

  func dismissThreadFeedback(_ id: UUID) {
    navigationActions.dismissThreadFeedback(id)
  }

  @discardableResult
  func moveToProject(
    _ id: String, projectID: String?, didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    return await navigationActions.moveToProject(id, projectID: projectID, didBegin: didBegin)
  }

  @discardableResult
  func setArchived(
    _ id: String, archived: Bool, leaveDetail: Bool = false,
    restoreOnUndo: Bool = false, reopenOnSuccess: Bool = false,
    eventID: String = UUID().uuidString.lowercased()
  ) async -> Bool {
    return await navigationActions.setArchived(
      id, archived: archived, leaveDetail: leaveDetail, restoreOnUndo: restoreOnUndo,
      reopenOnSuccess: reopenOnSuccess, eventID: eventID)
  }

  func setMuted(_ id: String, muted: Bool, markRead: Bool = true) async {
    await navigationActions.setMuted(id, muted: muted, markRead: markRead)
  }

  func startFork(_ selection: ChatFeedbackSelection, from conversation: ConversationStore) {
    navigationActions.startFork(selection, from: conversation)
  }

  func dismissFork() {
    navigationActions.dismissFork()
  }

}
