import ChatData
import ChatDomain
import Foundation
import Observation

/// Owns row mutation identities, optimistic events and their original command Tasks.
@MainActor @Observable
final class ThreadListMutations {
  private weak var owner: ThreadListStore?
  private let client: APIClient
  private let commands: ChatCommands
  private let lifecycleTasks: LifecycleTasks
  private let readThreads: @MainActor () -> [ChatThread]
  private let isClosed: @MainActor () -> Bool
  private let isBlocked: @MainActor () -> Bool
  private let setBlocked: @MainActor (Bool) -> Void
  private let isMarkingRead: @MainActor () -> Bool
  private let canMute: @MainActor (String) -> Bool
  private let didProject: @MainActor ([ChatThread]) -> Void
  private let refreshList: @MainActor (Bool, Bool) async -> Void
  private let didMarkRead: @MainActor (String, Date?) -> Void
  private let advanceReadRevision: @MainActor () -> Void
  private let didFail: @MainActor (Error) -> Void

  private var threads: [ChatThread] { readThreads() }
  private var closed: Bool { isClosed() }
  private var markingAllRead: Bool { isMarkingRead() }
  private var blocked: Bool {
    get { isBlocked() }
    set { setBlocked(newValue) }
  }

  init(
    owner: ThreadListStore, client: APIClient, commands: ChatCommands,
    lifecycleTasks: LifecycleTasks,
    readThreads: @escaping @MainActor () -> [ChatThread],
    isClosed: @escaping @MainActor () -> Bool, isBlocked: @escaping @MainActor () -> Bool,
    setBlocked: @escaping @MainActor (Bool) -> Void,
    isMarkingRead: @escaping @MainActor () -> Bool, canMute: @escaping @MainActor (String) -> Bool,
    didProject: @escaping @MainActor ([ChatThread]) -> Void,
    refreshList: @escaping @MainActor (Bool, Bool) async -> Void,
    didMarkRead: @escaping @MainActor (String, Date?) -> Void,
    advanceReadRevision: @escaping @MainActor () -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.owner = owner
    self.client = client
    self.commands = commands
    self.lifecycleTasks = lifecycleTasks
    self.readThreads = readThreads
    self.isClosed = isClosed
    self.isBlocked = isBlocked
    self.setBlocked = setBlocked
    self.isMarkingRead = isMarkingRead
    self.canMute = canMute
    self.didProject = didProject
    self.refreshList = refreshList
    self.didMarkRead = didMarkRead
    self.advanceReadRevision = advanceReadRevision
    self.didFail = didFail
  }

  private var pinTasks: [String: Task<Void, Never>] = [:]
  private var lastPinIDs: [String: String] = [:]
  private var optimisticChanges: [(id: String, change: ChatThreadChange)] = []
  private(set) var actionError: String?
  private(set) var updatingThreads: Set<String> = []
  private var updateTasks: [String: Task<Void, Never>] = [:]

  func canPin(_ id: String) -> Bool {
    !closed && !blocked && (!updatingThreads.contains(id) || lastPinIDs[id] != nil)
  }

  func setPinned(_ thread: ChatThread, pinned: Bool) async {
    guard canPin(thread.id), !Task.isCancelled,
      let current = threads.first(where: { $0.id == thread.id }),
      (current.pinnedAt != nil) != pinned
    else { return }
    // Match PostgreSQL's canonical UUID text in the persistent event stream.
    let eventID = UUID().uuidString.lowercased()
    let pinOrder: String?
    do {
      pinOrder =
        pinned
        ? try ChatThreadReplay.firstPinOrder(
          threads.filter { $0.projectId == current.projectId && $0.id != current.id }) : nil
    } catch {
      show(error)
      return
    }
    optimisticChanges.append(
      (
        eventID,
        ChatThreadChange(
          kind: pinned ? .pinned : .unpinned, chatThreadId: current.id,
          pinOrder: pinOrder, createdAt: .now)
      ))
    projectThreads(threads)
    let previous = lastPinIDs[current.id].flatMap { pinTasks[$0] }
    let task = Task { [weak self, weak owner = owner] in
      guard let self, let owner else { return }
      defer { withExtendedLifetime(owner) {} }
      defer {
        pinTasks[eventID] = nil
        if lastPinIDs[current.id] == eventID {
          lastPinIDs[current.id] = nil
          updatingThreads.remove(current.id)
        }
      }
      await previous?.value
      guard !closed, !blocked, !Task.isCancelled else { return }
      do {
        try await commands.setPinned(
          threadID: current.id, pinned: pinned, eventID: eventID, pinOrder: pinOrder)
        try Task.checkCancellation()
        guard !closed else { return }
        await refresh(includingIndicators: false)
      } catch is CancellationError {
      } catch { show(error) }
    }
    lifecycleTasks.track(task)
    pinTasks[eventID] = task
    lastPinIDs[current.id] = eventID
    updatingThreads.insert(current.id)
    await task.value
  }

  /// Places a pinned chat beside another pin listed with it, as the PWA's Move up / Move down.
  /// Only the moved rank and tied ranks change within the current list.
  func movePinned(
    _ id: String, beside targetID: String, placement: ChatThreadReplay.PinPlacement,
    projectID: String? = nil
  ) async {
    guard canUpdate(id), !Task.isCancelled,
      let current = threads.first(where: { $0.id == id }), current.pinnedAt != nil
    else { return }
    let ranked = threads.filter { thread in
      if let projectID { return thread.projectId == projectID }
      return thread.projectId == nil
    }
    let updates: [ChatThreadReplay.PinOrderUpdate]
    do {
      updates = try ChatThreadReplay.movePinOrder(
        ranked, threadID: id, targetID: targetID, placement: placement)
    } catch {
      show(error)
      return
    }
    guard !updates.isEmpty else { return }
    // Match PostgreSQL's canonical UUID text in the persistent event stream.
    let writes = updates.map { (eventID: UUID().uuidString.lowercased(), update: $0) }
    for write in writes {
      optimisticChanges.append(
        (
          write.eventID,
          ChatThreadChange(
            kind: .sortTouched, chatThreadId: write.update.threadID,
            pinOrder: write.update.pinOrder, createdAt: .now)
        ))
    }
    projectThreads(threads)
    await updateThread(id) { [commands] in
      for write in writes {
        try await commands.setPinOrder(
          threadID: write.update.threadID, pinOrder: write.update.pinOrder,
          eventID: write.eventID)
      }
    }
  }

  func settleOptimisticChanges(eventIDs: Set<String>) {
    var confirmedMemberships: [String: Int] = [:]
    for (index, event) in optimisticChanges.enumerated()
    where event.change.kind == .projectUpdated && eventIDs.contains(event.id) {
      confirmedMemberships[event.change.chatThreadId] = index
    }
    optimisticChanges = optimisticChanges.enumerated().filter { index, event in
      !eventIDs.contains(event.id)
        && (event.change.kind != .projectUpdated
          || index > (confirmedMemberships[event.change.chatThreadId] ?? -1))
    }.map(\.element)
  }

  @discardableResult
  func setProject(
    _ id: String, projectID: String?, onFailure: (@MainActor (String) -> Void)? = nil,
    didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    guard canUpdate(id), !Task.isCancelled,
      let current = threads.first(where: { $0.id == id })
    else { return false }
    let pending = optimisticChanges.last {
      $0.change.kind == .projectUpdated && $0.change.chatThreadId == id
    }
    let retry = pending.map { $0.change.projectId == projectID } ?? false
    guard current.projectId != projectID || retry else { return false }
    let eventID: String
    if let pending, pending.change.projectId == projectID {
      eventID = pending.id
    } else {
      eventID = ChatProjects.operationID()
      optimisticChanges.append(
        (
          eventID,
          ChatThreadChange(
            kind: .projectUpdated, chatThreadId: id,
            projectId: projectID, createdAt: current.updatedAt)
        ))
    }
    projectThreads(threads)
    return await updateThread(id, onFailure: onFailure, didBegin: didBegin) { [client] in
      try await ChatProjects(client: client).move(
        threadID: id, projectID: projectID, eventID: eventID)
    }
  }

  func dismissError() {
    actionError = nil
  }

  /// Whether a write may start, apart from the chat still being listed: a delete retry targets
  /// a chat its own optimistic event already hides.
  func canWrite(_ id: String) -> Bool {
    !closed && !blocked && !updatingThreads.contains(id) && !markingAllRead
  }

  func canUpdate(_ id: String) -> Bool {
    canWrite(id) && threads.contains(where: { $0.id == id })
  }

  @discardableResult
  func setArchived(
    _ thread: ChatThread, archived: Bool, eventID: String = UUID().uuidString.lowercased(),
    onFailure: (@MainActor (String) -> Void)? = nil,
    didBegin: @MainActor () -> Void = {}
  ) async -> Bool {
    guard canUpdate(thread.id), !Task.isCancelled else { return false }
    if !optimisticChanges.contains(where: { $0.id == eventID }) {
      optimisticChanges.append(
        (
          eventID,
          ChatThreadChange(
            kind: archived ? .archived : .unarchived, chatThreadId: thread.id,
            createdAt: .now)
        ))
    }
    projectThreads(threads)
    didBegin()
    return await updateThread(
      thread.id, includingIndicators: true, onFailure: onFailure
    ) { [commands] in
      try await commands.setArchived(threadID: thread.id, archived: archived, eventID: eventID)
    }
  }

  /// The chat leaves the list at once. Its optimistic event stays until the persistent event
  /// settles it, even when the request fails; a retry resends the same event.
  @discardableResult
  func delete(
    _ id: String, eventID: String,
    onFailure: (@MainActor (String) -> Void)? = nil
  ) async -> Bool {
    let pending = optimisticChanges.contains { $0.id == eventID }
    guard pending ? canWrite(id) : canUpdate(id), !Task.isCancelled else { return false }
    if !pending {
      optimisticChanges.append(
        (
          eventID,
          ChatThreadChange(kind: .deleted, chatThreadId: id, createdAt: .now)
        ))
      projectThreads(threads)
    }
    return await updateThread(
      id, includingIndicators: true, onFailure: onFailure
    ) { [commands] in
      try await commands.deleteThread(threadID: id, eventID: eventID)
    }
  }

  @discardableResult
  func setMuted(
    _ id: String, muted: Bool, markRead: Bool = true,
    onFailure: (@MainActor (String) -> Void)? = nil
  ) async -> Bool {
    guard canMute(id), !Task.isCancelled else { return false }
    advanceReadRevision()
    return await updateThread(
      id, includingIndicators: true, onFailure: onFailure
    ) { [self, commands] in
      // Replies suppressed while muted must not reappear as unread. Keep the chat
      // muted if marking read fails; retry can safely repeat both operations.
      if !muted && markRead {
        let watermark = try await commands.markRead(threadID: id)
        try Task.checkCancellation()
        didMarkRead(id, watermark)
      }
      try await commands.setMuted(
        threadID: id, muted: muted, eventID: UUID().uuidString.lowercased())
      advanceReadRevision()
    }
  }

  @discardableResult
  func rename(_ thread: ChatThread, title: String) async -> Bool {
    guard canUpdate(thread.id), !Task.isCancelled,
      let current = threads.first(where: { $0.id == thread.id })
    else { return false }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    let pending = optimisticChanges.last {
      $0.change.kind == .renamed && $0.change.chatThreadId == thread.id
    }
    // A title already shown optimistically still needs an explicit retry until confirmed.
    guard !trimmed.isEmpty,
      trimmed != current.title.trimmingCharacters(in: .whitespacesAndNewlines)
        || pending?.change.title == trimmed
    else { return true }
    let eventID: String
    if let pending, pending.change.title == trimmed {
      eventID = pending.id
    } else {
      eventID = UUID().uuidString.lowercased()
      optimisticChanges.append(
        (
          eventID,
          ChatThreadChange(
            kind: .renamed, chatThreadId: current.id,
            title: trimmed, createdAt: .now)
        ))
    }
    projectThreads(threads)
    return await updateThread(thread.id) { [commands] in
      try await commands.rename(threadID: thread.id, title: trimmed, eventID: eventID)
    }
  }

  @discardableResult
  func updateThread(
    _ id: String, includingIndicators: Bool = false,
    onFailure: (@MainActor (String) -> Void)? = nil,
    didBegin: @MainActor () -> Void = {},
    command: @escaping @MainActor () async throws -> Void
  ) async -> Bool {
    guard updateTasks[id] == nil, !updatingThreads.contains(id), !closed, !blocked,
      !Task.isCancelled
    else { return false }
    updatingThreads.insert(id)
    var succeeded = false
    let task = Task { [weak self, weak owner = owner] in
      guard let self, let owner else { return }
      defer { withExtendedLifetime(owner) {} }
      defer {
        updatingThreads.remove(id)
        updateTasks[id] = nil
      }
      do {
        try await command()
        try Task.checkCancellation()
        guard !closed else { return }
        actionError = nil
        succeeded = true
        await refresh(waitForCurrent: true, includingIndicators: includingIndicators)
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return }
        if let onFailure {
          blocked = (error as? APIClientError)?.statusCode == 426
          didFail(error)
          onFailure(error.localizedDescription)
        } else {
          show(error)
        }
      }
    }
    lifecycleTasks.track(task)
    updateTasks[id] = task
    didBegin()
    await task.value
    return succeeded && !closed && !blocked
  }

  func show(_ failure: Error) {
    guard !closed, !Task.isCancelled else { return }
    actionError = failure.localizedDescription
    blocked = (failure as? APIClientError)?.statusCode == 426
    didFail(failure)
  }
  func projected(_ snapshot: [ChatThread]) -> [ChatThread] {
    ChatThreadReplay.sidebarOrder(
      ChatThreadReplay.replay(snapshot: snapshot, events: optimisticChanges.map(\.change)))
  }

  private func projectThreads(_ snapshot: [ChatThread]) { didProject(projected(snapshot)) }

  private func refresh(waitForCurrent: Bool = false, includingIndicators: Bool = true) async {
    await refreshList(waitForCurrent, includingIndicators)
  }

  func beginUpdating(_ id: String) { updatingThreads.insert(id) }
  func finishUpdating(_ id: String) { updatingThreads.remove(id) }

  func close() {
    for task in updateTasks.values { task.cancel() }
    for task in pinTasks.values { task.cancel() }
  }

}
