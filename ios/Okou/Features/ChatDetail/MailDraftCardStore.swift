import CCState
import ChatData
import ChatDomain
import Foundation

/// One draft's original read Task and explicit, conversation-owned mail operation.
@MainActor
final class MailDraftCardStore {
  private enum ReadSource: Equatable, Sendable {
    case remote
    // Authoritative mutation response, not a second copy of read loading/data/error.
    case confirmed(ChatMailDraft?)
  }

  /// The explicit Send or Discard: whether it is running, whether its outcome still needs a
  /// read-only check, its failure, and how many sends the provider confirmed.
  struct Attempt: Equatable {
    var isWorking = false
    var requiresReadback = false
    var error: String?
    var sentCount = 0
  }

  /// What the card shows besides the draft: whether its row is active, and the attempt.
  struct Presentation: Equatable {
    var isActive = false
    var attempt = Attempt()
  }

  let id: String
  /// The workspace session Store that keeps this card's graph values.
  let stateStore: CCState.Store
  let requested: Computed<Bool>
  let presentation: Computed<Presentation>
  private let attempt = CCState.State(Attempt())
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
  private var current: Task<ChatMailDraft?, Error>?
  private var pending: UUID?
  private var operation: Task<Void, Never>?
  private var generation = UUID()
  private var closed = false

  /// Activation is the read's `available` input.
  var isActive: Bool { snapshot(of: available) }
  var isWorking: Bool { snapshot(of: attempt).isWorking }
  var requiresReadback: Bool { snapshot(of: attempt).requiresReadback }
  var error: String? { snapshot(of: attempt).error }
  var sentCount: Int { snapshot(of: attempt).sentCount }

  init(
    id: String, client: APIClient, graph: CCState.Store,
    didFail: @escaping @MainActor (Error) -> Void,
    didBeginMutation: @escaping @MainActor (MailDraftCardStore) -> Void
  ) {
    self.id = id
    stateStore = graph
    self.client = client
    self.didFail = didFail
    self.didBeginMutation = didBeginMutation
    let available = available
    let demand = demand
    let revision = revision
    let source = source
    let attempt = attempt
    requested = Computed { get in try get(available) && get(demand) }
    presentation = Computed { get in
      let isActive = try get(available)
      let current = try get(attempt)
      return Presentation(isActive: isActive, attempt: current)
    }
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

  lazy var value = makeValue()

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
    // A pending confirmed-result presentation is not an HTTP read to coalesce with.
    let replacingConfirmation = try stateStore.get(source) != .remote
    try stateStore.set(request, refresh && (pending == nil || replacingConfirmation))
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
      if !isWorking, case .remote = try stateStore.get(source) {
        update { $0.requiresReadback = false }
      }
    } catch {
      // The original Task retains the failure and the native card offers explicit retry.
    }
  }

  func refresh() async {
    guard !isWorking else { return }
    do {
      _ = try await read(refresh: true)
      guard !isWorking, case .remote = try stateStore.get(source) else { return }
      update {
        $0.requiresReadback = false
        $0.error = nil
      }
    } catch {
      // Read retry never submits Send or Discard; its original Task presents any failure.
    }
  }

  func send() async { await mutate(sending: true) }
  func discard() async { await mutate(sending: false) }

  private func mutate(sending: Bool) async {
    guard isActive, !closed, operation == nil, !requiresReadback, !Task.isCancelled else { return }
    update {
      $0.isWorking = true
      $0.error = nil
    }
    let generation = generation
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      defer {
        if self.generation == generation {
          update { $0.isWorking = false }
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
        update { $0.requiresReadback = true }
        if sending {
          let result = try await client.sendMailDraft(id: id)
          try checkOwner(generation)
          current?.cancel()
          pending = nil
          try stateStore.set(confirm, result)
          update {
            $0.requiresReadback = false
            if result.status == .sent { $0.sentCount += 1 }
          }
        } else {
          try await client.discardMailDraft(id: id)
          try checkOwner(generation)
          try await readbackAfterMutation()
          try checkOwner(generation)
          update { $0.requiresReadback = false }
        }
      } catch is CancellationError {
      } catch {
        guard !closed, isActive, self.generation == generation, !Task.isCancelled else { return }
        let message: String
        if let failure = error as? APIClientError, sending, failure.statusCode == 400 {
          message = String(
            localized: "The mail provider rejected this email. Check the recipients.")
        } else if let failure = error as? APIClientError, sending, failure.statusCode == 409 {
          message = String(localized: "This draft can no longer be sent.")
        } else {
          message = ChatRequestFailure.message(for: error)
        }
        update { $0.error = message }
        didFail(error)
        // Known provider rejection reconciles with a read, never another write.
        if let failure = error as? APIClientError, sending,
          failure.statusCode == 400 || failure.statusCode == 409
        {
          do {
            try await readbackAfterMutation()
            try checkOwner(generation)
            update { $0.requiresReadback = false }
          } catch {}
        }
      }
    }
    operation = task
    await task.value
  }

  private func readbackAfterMutation() async throws {
    // Readback must start after the write response, not reuse an older in-flight GET.
    current?.cancel()
    pending = nil
    _ = try await read(refresh: true)
  }

  private func checkOwner(_ generation: UUID) throws {
    try Task.checkCancellation()
    guard isActive, !closed, self.generation == generation else { throw CancellationError() }
  }

  func activate() {
    guard !isActive, !closed else { return }
    do { try stateStore.set(setAvailability, true) } catch { didFail(error) }
  }

  func deactivate() {
    generation = UUID()
    current?.cancel()
    current = nil
    pending = nil
    operation?.cancel()
    operation = nil
    update { $0.isWorking = false }
    do { try stateStore.set(setAvailability, false) } catch { didFail(error) }
  }

  func close() {
    closed = true
    deactivate()
    update { $0.error = nil }
  }

  // The card's own states are synchronous in-process values; reads and writes cannot fail.
  private func snapshot<Value>(of signal: Signal<Value>) -> Value {
    do { return try stateStore.get(signal) } catch {
      preconditionFailure("Cannot read the mail draft card graph: \(error)")
    }
  }

  private func update(_ mutation: (inout Attempt) -> Void) {
    var next = snapshot(of: attempt)
    mutation(&next)
    do { try stateStore.set(attempt, next) } catch {
      preconditionFailure("Cannot update the mail draft card graph: \(error)")
    }
  }

  isolated deinit {
    current?.cancel()
    operation?.cancel()
  }
}
