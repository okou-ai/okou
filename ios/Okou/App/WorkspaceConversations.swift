import ChatData
import ChatDomain
import Foundation
import OSLog

/// Resident conversations, history warming and LRU release share one workspace lifetime.
@MainActor
final class WorkspaceConversations {
  private let sync: ChatSync
  private let limit: Int
  private let lifecycleTasks: LifecycleTasks
  private let markdown: MessageMarkdownCache
  private let historyWarmingSleep: @Sendable (Duration) async throws -> Void
  private let threads: @MainActor () -> [ChatThread]
  private let isProtected: @MainActor (String) -> Bool
  private let canWarm: @MainActor () -> Bool
  private let generation: @MainActor () -> UUID?
  private let didRelease: @MainActor (String, Bool) -> Void
  private let handle: @MainActor (Error) -> Void
  private var conversations: [String: ConversationStore] = [:]
  private var lastUse: [String: UInt64] = [:]
  private var clock: UInt64 = 0
  private var pruneTask: Task<Void, Never>?
  private var pruneAgain = false
  private var warmingTask: Task<Void, Never>?
  private var warmAgain = false
  private var closed = false

  init(
    sync: ChatSync, limit: Int, lifecycleTasks: LifecycleTasks, markdown: MessageMarkdownCache,
    sleep: @escaping @Sendable (Duration) async throws -> Void,
    threads: @escaping @MainActor () -> [ChatThread],
    isProtected: @escaping @MainActor (String) -> Bool,
    canWarm: @escaping @MainActor () -> Bool, generation: @escaping @MainActor () -> UUID?,
    didRelease: @escaping @MainActor (String, Bool) -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.sync = sync
    self.limit = limit
    self.lifecycleTasks = lifecycleTasks
    self.markdown = markdown
    historyWarmingSleep = sleep
    self.threads = threads
    self.isProtected = isProtected
    self.canWarm = canWarm
    self.generation = generation
    self.didRelease = didRelease
    handle = didFail
  }

  var values: [ConversationStore] { Array(conversations.values) }
  subscript(_ id: String) -> ConversationStore? { conversations[id] }
  var needsWarming: Bool { warmAgain }

  func retain(_ id: String, create: () -> ConversationStore) -> ConversationStore {
    clock &+= 1
    lastUse[id] = clock
    if let conversation = conversations[id] { return conversation }
    let conversation = create()
    conversations[id] = conversation
    return conversation
  }

  func noteHistoryChange() { warmAgain = true }

  func suspendWarming() {
    if let warmingTask, !warmingTask.isCancelled { warmAgain = true }
    warmingTask?.cancel()
    warmingTask = nil
  }

  func requestHistoryWarming() {
    guard !closed, canWarm() else { return }
    warmAgain = true
    guard warmingTask == nil else { return }
    let generation = generation()
    warmingTask = Task(priority: .utility) { [weak self] in
      guard let self else { return }
      defer {
        if self.generation() == generation { warmingTask = nil }
      }
      repeat {
        // Coalesce startup, indicator updates and bursts of realtime messages.
        do { try await historyWarmingSleep(.seconds(1)) } catch { return }
        guard !closed, canWarm(), !Task.isCancelled,
          self.generation() == generation
        else { return }
        warmAgain = false
        let recent = threads().sorted {
          $0.sortAt == $1.sortAt ? $0.id > $1.id : $0.sortAt > $1.sortAt
        }.prefix(100)
        let candidates = Set(
          recent.map(\.id) + threads().filter { $0.indicator != nil }.map(\.id))
        let ids = candidates.filter { conversations[$0] == nil }.sorted()
        do {
          try await sync.warmHistories(threadIDs: ids)
        } catch is CancellationError {
          return
        } catch {
          guard !closed, !Task.isCancelled else { return }
          handle(error)
          Logger(subsystem: "ai.okou.ios", category: "ChatCache")
            .error(
              "event=chat.history.warm.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
            )
        }
      } while warmAgain && !closed && canWarm() && !Task.isCancelled
    }
    if let warmingTask { lifecycleTasks.track(warmingTask) }
  }

  func requestPrune() {
    guard !closed else { return }
    pruneAgain = true
    guard pruneTask == nil else { return }
    pruneTask = Task { [weak self] in
      guard let self else { return }
      defer { pruneTask = nil }
      repeat {
        pruneAgain = false
        await trimConversations(limit: limit)
      } while pruneAgain && !closed && !Task.isCancelled
    }
    if let pruneTask { lifecycleTasks.track(pruneTask) }
  }

  func trimConversations(limit: Int) async {
    let candidates = conversations.keys.sorted { (lastUse[$0] ?? 0) < (lastUse[$1] ?? 0) }
    for id in candidates {
      guard !closed, !Task.isCancelled else { return }
      let removed = !threads().contains(where: { $0.id == id })
      guard removed || conversations.count > limit else { continue }
      guard !isProtected(id),
        let conversation = conversations[id], conversation.canRelease
      else { continue }
      guard await sync.releaseHistory(threadID: id), !closed, !isProtected(id),
        conversation.canRelease, conversations[id] === conversation
      else { continue }
      didRelease(id, conversation.composer.hasContent)
      conversation.close()
      conversations[id] = nil
      lastUse[id] = nil
    }
  }

  func reduceMemory() async {
    warmingTask?.cancel()
    warmAgain = false
    markdown.clear()
    for conversation in conversations.values { conversation.measurements.clear() }
    await trimConversations(limit: 0)
  }

  func close() {
    closed = true
    pruneTask?.cancel()
    warmingTask?.cancel()
    for conversation in conversations.values { conversation.close() }
  }
}

extension WorkspaceStore {
  func reduceMemory() async { await residentConversations.reduceMemory() }
}

struct WorkspaceNotificationReadState: Equatable {
  let agentID: String?
  let hidden: Bool
  let muted: Bool
  let archived: Bool
  let unreadAt: Date?

  static func snapshot(_ threads: [ChatThread]) -> [String: WorkspaceNotificationReadState] {
    Dictionary(
      uniqueKeysWithValues: threads.map {
        (
          $0.id,
          WorkspaceNotificationReadState(
            agentID: $0.agentID, hidden: $0.isHidden, muted: $0.isMuted,
            archived: $0.isArchived, unreadAt: $0.unreadAt)
        )
      })
  }
}
