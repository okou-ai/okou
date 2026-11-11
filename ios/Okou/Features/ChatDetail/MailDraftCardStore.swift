import CCState
import ChatData
import ChatDomain
import Foundation
import Observation

/// One draft's original read Task and explicit, conversation-owned mail operation.
@MainActor @Observable
final class MailDraftCardStore {
  private enum ReadSource: Equatable, Sendable {
    case remote
    // Authoritative mutation response, not a second copy of read loading/data/error.
    case confirmed(ChatMailDraft?)
  }

  let id: String
  let stateStore = CCState.Store()
  let requested: Computed<Bool>
  private(set) var isActive = false
  private(set) var isWorking = false
  private(set) var requiresReadback = false
  private(set) var error: String?
  private(set) var sentCount = 0
  private let available = CCState.State(false)
  private let demand = CCState.State(false)
  private let revision = CCState.State(0)
  private let source = CCState.State(ReadSource.remote)
  private let request: Command<Void, Bool>
  private let setAvailability: Command<Void, Bool>
  private let confirm: Command<Void, ChatMailDraft?>
  private let client: APIClient
  private let didFail: @MainActor (Error) -> Void
  private let didBeginMutation: @MainActor (MailDraftCardStore) -> Void
  @ObservationIgnored private var current: Task<ChatMailDraft?, Error>?
  @ObservationIgnored private var pending: UUID?
  @ObservationIgnored private var operation: Task<Void, Never>?
  @ObservationIgnored private var generation = UUID()
  @ObservationIgnored private var closed = false

  init(
    id: String, client: APIClient, didFail: @escaping @MainActor (Error) -> Void,
    didBeginMutation: @escaping @MainActor (MailDraftCardStore) -> Void
  ) {
    self.id = id
    self.client = client
    self.didFail = didFail
    self.didBeginMutation = didBeginMutation
    let available = available
    let demand = demand
    let revision = revision
    let source = source
    requested = Computed { get in try get(available) && get(demand) }
    request = Command { context, refresh in
      guard try context.get(available) else { throw CancellationError() }
      if try !context.get(demand) { try context.set(demand, true) }
      if refresh {
        try context.set(source, .remote)
        try context.set(revision, update: { $0 + 1 })
      }
    }
    setAvailability = Command { context, active in
      try context.set(available, active)
      if !active {
        try context.set(demand, false)
        try context.set(source, .remote)
      }
    }
    confirm = Command { context, draft in try context.set(source, .confirmed(draft)) }
  }

  @ObservationIgnored lazy var value = makeValue()

  private func makeValue() -> Computed<Task<ChatMailDraft?, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(available), try get(demand) else {
        throw CancellationError()
      }
      _ = try get(revision)
      let source = try get(source)
      let signal = options.signal
      let id = UUID()
      pending = id
      let task = Task<ChatMailDraft?, Error> { @MainActor [self] in
        defer { if pending == id { pending = nil } }
        do {
          try Task.checkCancellation()
          let draft: ChatMailDraft?
          switch source {
          case .remote: draft = try await client.mailDraft(id: self.id)
          case .confirmed(let value): draft = value
          }
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard isActive, !closed else { throw CancellationError() }
          return draft
        } catch {
          if isActive, !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      current = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  /// A cancelled row waiter detaches; only invalidation or owner retirement cancels HTTP.
  func read(refresh: Bool = false) async throws -> ChatMailDraft? {
    guard isActive, !closed, !Task.isCancelled else { throw CancellationError() }
    let generation = generation
    try stateStore.set(request, refresh && pending == nil)
    var task = try stateStore.get(value)
    while true {
      let result = await task.result
      try checkOwner(generation)
      let latest = try stateStore.get(value)
      if latest != task {
        task = latest
        continue
      }
      return try result.get()
    }
  }

  func load() async {
    guard !isWorking else { return }
    do {
      _ = try await read()
      if case .remote = try stateStore.get(source) { requiresReadback = false }
    } catch {
      // The original Task retains the failure and the native card offers explicit retry.
    }
  }

  func refresh() async {
    guard !isWorking else { return }
    do {
      _ = try await read(refresh: true)
      requiresReadback = false
      error = nil
    } catch {
      // Read retry never submits Send or Discard; its original Task presents any failure.
    }
  }

  func send() async { await mutate(sending: true) }
  func discard() async { await mutate(sending: false) }

  private func mutate(sending: Bool) async {
    guard isActive, !closed, operation == nil, !requiresReadback, !Task.isCancelled else { return }
    isWorking = true
    error = nil
    let generation = generation
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          isWorking = false
          operation = nil
        }
      }
      do {
        let draft = try await read()
        try checkOwner(generation)
        guard let draft, draft.status == .draft, draft.detailAvailable else {
          throw ChatError.invalidContract("This draft is no longer available.")
        }
        if sending && (draft.needsReconnect || draft.to.isEmpty) {
          throw ChatError.invalidContract("Reconnect your mail account and check the recipients.")
        }
        didBeginMutation(self)
        // Freeze the reviewed baseline while the explicit write owns the transition.
        // A late read cannot replace either this baseline or the confirmed response.
        current?.cancel()
        pending = nil
        try stateStore.set(confirm, draft)
        requiresReadback = true
        if sending {
          let result = try await client.sendMailDraft(id: id)
          try checkOwner(generation)
          current?.cancel()
          pending = nil
          try stateStore.set(confirm, result)
          requiresReadback = false
          if result.status == .sent { sentCount += 1 }
        } else {
          try await client.discardMailDraft(id: id)
          try checkOwner(generation)
          _ = try await read(refresh: true)
          try checkOwner(generation)
          requiresReadback = false
        }
      } catch is CancellationError {
      } catch {
        guard !closed, isActive, self.generation == generation, !Task.isCancelled else { return }
        if let failure = error as? APIClientError, sending, failure.statusCode == 400 {
          self.error = String(
            localized: "The mail provider rejected this email. Check the recipients.")
        } else if let failure = error as? APIClientError, sending, failure.statusCode == 409 {
          self.error = String(localized: "This draft can no longer be sent.")
        } else {
          self.error = ChatRequestFailure.message(for: error)
        }
        didFail(error)
        // Known provider rejection reconciles with a read, never another write.
        if let failure = error as? APIClientError, sending,
          failure.statusCode == 400 || failure.statusCode == 409
        {
          do {
            _ = try await read(refresh: true)
            try checkOwner(generation)
            requiresReadback = false
          } catch {}
        }
      }
    }
    operation = task
    await task.value
  }

  private func checkOwner(_ generation: UUID) throws {
    try Task.checkCancellation()
    guard isActive, !closed, self.generation == generation else { throw CancellationError() }
  }

  func activate() {
    guard !isActive, !closed else { return }
    isActive = true
    do { try stateStore.set(setAvailability, true) } catch { didFail(error) }
  }

  func deactivate() {
    isActive = false
    generation = UUID()
    current?.cancel()
    current = nil
    pending = nil
    operation?.cancel()
    operation = nil
    isWorking = false
    do { try stateStore.set(setAvailability, false) } catch { didFail(error) }
  }

  func close() {
    closed = true
    deactivate()
    error = nil
  }

  isolated deinit {
    current?.cancel()
    operation?.cancel()
  }
}
