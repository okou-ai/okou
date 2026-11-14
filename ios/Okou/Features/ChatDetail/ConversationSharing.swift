import ChatData
import ChatDomain
import Foundation
import Observation

/// One presentation-scoped operation; selection identity survives cell reuse and paging.
@MainActor @Observable
final class ConversationSharing {
  private let client: APIClient
  private let threadID: String
  private let webURL: URL
  private let lifecycleTasks: LifecycleTasks
  private let history: @MainActor () -> ChatHistory
  private let didFail: @MainActor (Error) -> Void
  private(set) var isSelecting = false
  private var selectedGroups: [String: ChatShareGroup] = [:]
  var audience: ChatShareAudience = .public
  private(set) var error: String?
  private(set) var isBusy = false
  private(set) var visibility: ChatShareVisibility?
  var showsCreatedLink = false
  private var singleAttempt: (key: String, id: String)?
  private var attemptID: String?
  private var task: Task<Void, Never>?
  private var generation = UUID()
  private var closed = false

  init(
    client: APIClient, threadID: String, webURL: URL, lifecycleTasks: LifecycleTasks,
    history: @escaping @MainActor () -> ChatHistory,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.client = client
    self.threadID = threadID
    self.webURL = webURL
    self.lifecycleTasks = lifecycleTasks
    self.history = history
    self.didFail = didFail
  }

  var groups: [ChatShareGroup] { ChatShareGroup.groups(in: history()) }
  private var currentSelection: [ChatShareGroup] {
    let selectedIDs = Set(selectedGroups.values.flatMap(\.eventIDs))
    return groups.compactMap { group in
      let messages = group.messages.filter { selectedIDs.contains($0.id) }
      return messages.isEmpty ? nil : ChatShareGroup(id: group.id, messages: messages)
    }
  }
  var selectedIDs: Set<String> { Set(currentSelection.flatMap(\.eventIDs)) }
  var selectedCount: Int { currentSelection.count }
  var link: URL? { visibility.map { webURL.appending(path: "share/threads/\($0.id)") } }

  func selectedIDs(in group: ChatShareGroup) -> Set<String> {
    let storedIDs = Set(selectedGroups.values.flatMap(\.eventIDs))
    return Set(group.eventIDs).intersection(storedIDs)
  }

  func start() {
    guard !closed else { return }
    cancel()
    isSelecting = true
  }

  func toggle(_ group: ChatShareGroup) {
    guard !isBusy, visibility == nil else { return }
    var next = Dictionary(uniqueKeysWithValues: currentSelection.map { ($0.id, $0) })
    let storedIDs = Set(next[group.id]?.eventIDs ?? [])
    if Set(group.eventIDs).isSubset(of: storedIDs) {
      next.removeValue(forKey: group.id)
    } else {
      next[group.id] = group
    }
    guard next.values.reduce(0, { $0 + $1.textBytes }) <= 1_572_864 else {
      error = String(localized: "The selected messages are too large to share.")
      return
    }
    selectedGroups = next
    attemptID = nil
    error = nil
  }

  func clear() {
    guard !isBusy, visibility == nil else { return }
    selectedGroups = [:]
    attemptID = nil
    visibility = nil
    error = nil
  }

  @discardableResult
  func create() -> Task<Void, Never>? {
    guard !isBusy, visibility == nil, !selectedIDs.isEmpty else { return nil }
    let ids = selectedIDs
    let ordered = groups.flatMap(\.eventIDs).filter { ids.contains($0) }
    let audience = audience
    let previousAttempt = attemptID
    let id = previousAttempt ?? UUID().uuidString.lowercased()
    attemptID = id
    return run {
      // A previous request can have committed even if its response was lost.
      if previousAttempt != nil, let existing = try await self.existingShare(id) {
        try Task.checkCancellation()
        let confirmed: ChatShareVisibility
        if existing.audience == audience {
          confirmed = existing
        } else {
          confirmed = try await self.client.changeChatShareVisibility(
            id: id, audience: audience, revision: existing.revision)
        }
        try Task.checkCancellation()
        self.visibility = confirmed
        return
      }
      let created = try await self.client.shareThread(
        threadID: self.threadID, eventIDs: ordered, audience: audience, id: id)
      try Task.checkCancellation()
      // Creation confirms this audience. Fetch the current revision only when changing it.
      self.visibility = ChatShareVisibility(id: created, audience: audience, revision: nil)
    }
  }

  @discardableResult
  func changeAudience(_ audience: ChatShareAudience) -> Task<Void, Never>? {
    guard !isBusy, let visibility else { return nil }
    return run {
      let current = try await self.client.chatShareVisibility(id: visibility.id)
      try Task.checkCancellation()
      let updated = try await self.client.changeChatShareVisibility(
        id: visibility.id, audience: audience, revision: current.revision)
      try Task.checkCancellation()
      self.visibility = updated
      self.audience = updated.audience
    }
  }

  func singleAnswerLink(_ answerID: String, audience: ChatShareAudience) async throws -> URL {
    let eventIDs = ChatShareGroup.answerEventIDs(answerID, in: history())
    guard !eventIDs.isEmpty else {
      throw ChatError.invalidContract("This answer is no longer available for sharing.")
    }
    guard !closed else { throw CancellationError() }
    let key = ([audience.rawValue] + eventIDs).joined(separator: ":")
    let previous = singleAttempt
    let id: String
    if let previous, previous.key == key {
      id = previous.id
    } else {
      id = UUID().uuidString.lowercased()
    }
    singleAttempt = (key, id)
    if previous?.key == key, let existing = try await existingShare(id) {
      try Task.checkCancellation()
      if existing.audience != audience {
        _ = try await client.changeChatShareVisibility(
          id: id, audience: audience, revision: existing.revision)
        try Task.checkCancellation()
      }
    } else {
      _ = try await client.shareThread(
        threadID: threadID, eventIDs: eventIDs, audience: audience, id: id)
      try Task.checkCancellation()
    }
    guard !closed else { throw CancellationError() }
    singleAttempt = nil
    return webURL.appending(path: "share/threads/\(id)")
  }

  func cancel() {
    generation = UUID()
    task?.cancel()
    task = nil
    isBusy = false
    isSelecting = false
    selectedGroups = [:]
    attemptID = nil
    singleAttempt = nil
    visibility = nil
    showsCreatedLink = false
    error = nil
    audience = .public
  }

  func close() {
    cancel()
    closed = true
  }

  private func existingShare(_ id: String) async throws -> ChatShareVisibility? {
    do { return try await client.chatShareVisibility(id: id) } catch let error as APIClientError
      where error.statusCode == 404
    { return nil }
  }

  private func run(_ operation: @escaping @MainActor () async throws -> Void) -> Task<Void, Never>?
  {
    guard !closed else { return nil }
    task?.cancel()
    let generation = UUID()
    self.generation = generation
    isBusy = true
    error = nil
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          isBusy = false
          self.task = nil
        }
      }
      do { try await operation() } catch {
        guard !closed, !Task.isCancelled, self.generation == generation else { return }
        self.error = error.localizedDescription
        didFail(error)
      }
    }
    self.task = task
    lifecycleTasks.track(task)
    return task
  }

  isolated deinit { task?.cancel() }
}
