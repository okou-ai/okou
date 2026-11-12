import CCState
import ChatData
import ChatDomain
import Foundation

/// One menu presentation owns this read. It never selects a chat or changes its read cursor.
@MainActor
final class ChatThreadPreviewResources {
  let threadID: String
  let store = CCState.Store()
  private let lifetime = CCState.State(true)
  private let sync: ChatSync
  private let didFinish: @MainActor () async -> Void
  private let didFail: @MainActor (Error) -> Void
  private var request: Task<ChatThreadPreviewContent, Error>?
  private var closed = false

  init(
    threadID: String, sync: ChatSync,
    didFinish: @escaping @MainActor () async -> Void,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.threadID = threadID
    self.sync = sync
    self.didFinish = didFinish
    self.didFail = didFail
  }

  lazy var content = makeContent()

  private func makeContent() -> Computed<Task<ChatThreadPreviewContent, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      let signal = options.signal
      let task = Task<ChatThreadPreviewContent, Error> {
        @MainActor [weak self, sync, threadID, didFinish] in
        let history: ChatHistory
        do {
          try Task.checkCancellation()
          history = try await sync.eventHistory(threadID: threadID)
        } catch {
          await didFinish()
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard self?.closed == false else { throw CancellationError() }
          self?.didFail(error)
          throw error
        }
        await didFinish()
        try Task.checkCancellation()
        try signal.checkCancellation()
        guard self?.closed == false else { throw CancellationError() }
        return ChatThreadPreviewContent(history: history)
      }
      request = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func close() {
    guard !closed else { return }
    closed = true
    request?.cancel()
    request = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit { request?.cancel() }
}

/// Only the latest exchange is useful in a glance; intermediate work stays in the full chat.
struct ChatThreadPreviewContent: Sendable {
  let messages: [ChatMessage]
  let isWorking: Bool

  init(history: ChatHistory) {
    let workIDs = Set(history.workSections.flatMap(\.hiddenMessageIDs))
    let visible = history.messages.filter {
      ($0.role == .user || $0.role == .assistant) && !workIDs.contains($0.id)
        && $0.modelChange == nil
    }
    if let prompt = visible.lastIndex(where: { $0.role == .user }) {
      let reply = visible.suffix(from: prompt).last { $0.role == .assistant }
      messages = [visible[prompt]] + (reply.map { [$0] } ?? [])
    } else {
      messages = Array(visible.suffix(1))
    }
    isWorking = history.executionState.isActive
  }
}
