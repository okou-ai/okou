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
  private let didFail: @MainActor (Error) -> Void
  private(set) var isSelecting = false
  private(set) var selection: ChatShareSelection?
  private(set) var selectedIDs: Set<String> = []
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
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.client = client
    self.threadID = threadID
    self.webURL = webURL
    self.lifecycleTasks = lifecycleTasks
    self.didFail = didFail
  }

  var shareableIDs: Set<String> { Set(selection?.messages.map(\.eventId) ?? []) }
  var link: URL? { visibility.map { webURL.appending(path: "share/threads/\($0.id)") } }

  @discardableResult
  func start(answerID: String? = nil) -> Task<Void, Never>? {
    guard !closed else { return nil }
    cancel()
    isSelecting = true
    return run {
      let selection = try await self.client.chatShareSelection(threadID: self.threadID)
      try Task.checkCancellation()
      self.selection = selection
      if let answerID {
        guard let answer = selection.messages.first(where: { $0.eventId == answerID }) else {
          throw ChatError.invalidContract("This answer is no longer available for sharing.")
        }
        self.selectedIDs = Set(answer.turnEventIds)
      }
    }
  }

  func toggle(_ message: ChatMessage, messages: [ChatMessage]) {
    guard !isBusy, shareableIDs.contains(message.id) else { return }
    var next = selectedIDs
    if !next.insert(message.id).inserted { next.remove(message.id) }
    let bytes = messages.filter { next.contains($0.id) }.reduce(0) { $0 + $1.text.utf8.count }
    guard bytes <= 1_572_864 else {
      error = String(localized: "The selected messages are too large to share.")
      return
    }
    selectedIDs = next
    attemptID = nil
    visibility = nil
    error = nil
  }

  func clear() {
    guard !isBusy else { return }
    selectedIDs = []
    attemptID = nil
    visibility = nil
    error = nil
  }

  @discardableResult
  func create() -> Task<Void, Never>? {
    guard !isBusy, !selectedIDs.isEmpty else { return nil }
    let ids = selectedIDs
    let audience = audience
    let id = attemptID ?? UUID().uuidString.lowercased()
    attemptID = id
    return run {
      // A previous request can have committed even if its response was lost.
      if let existing = try await self.existingShare(id) {
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
        self.showsCreatedLink = true
        return
      }
      let current = try await self.client.chatShareSelection(threadID: self.threadID)
      try Task.checkCancellation()
      self.selection = current
      let valid = Set(current.messages.map(\.eventId))
      guard ids.isSubset(of: valid) else {
        self.selectedIDs.formIntersection(valid)
        self.attemptID = nil
        throw ChatError.invalidContract(
          "Selected messages changed. Review your selection and try again.")
      }
      let ordered = current.messages.map(\.eventId).filter { ids.contains($0) }
      let created = try await self.client.createSelectedChatShare(
        threadID: self.threadID, eventIDs: ordered, audience: audience, id: id)
      let visibility = try await self.client.chatShareVisibility(id: created)
      try Task.checkCancellation()
      self.visibility = visibility
      self.showsCreatedLink = true
    }
  }

  @discardableResult
  func changeAudience(_ audience: ChatShareAudience) -> Task<Void, Never>? {
    guard !isBusy, let visibility else { return nil }
    return run {
      let updated = try await self.client.changeChatShareVisibility(
        id: visibility.id, audience: audience, revision: visibility.revision)
      try Task.checkCancellation()
      self.visibility = updated
      self.audience = updated.audience
    }
  }

  func singleAnswerLink(_ answerID: String, audience: ChatShareAudience) async throws -> URL {
    let selection = try await client.chatShareSelection(threadID: threadID)
    try Task.checkCancellation()
    guard let message = selection.messages.first(where: { $0.eventId == answerID }) else {
      throw ChatError.invalidContract("This answer is no longer available for sharing.")
    }
    guard !closed else { throw CancellationError() }
    let key = ([audience.rawValue] + message.turnEventIds).joined(separator: ":")
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
      _ = try await client.createSelectedChatShare(
        threadID: threadID, eventIDs: message.turnEventIds, audience: audience, id: id)
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
    selection = nil
    selectedIDs = []
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
