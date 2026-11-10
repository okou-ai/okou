import CCState
import ChatData
import Foundation
import Observation

/// A conversation-keyed read resource and a separate explicitly confirmed mutation owner.
@MainActor @Observable
final class MailDraftCardStore {
  private enum Confirmed: Equatable {
    case none
    case result(ChatMailDraft?)
  }

  let id: String
  let stateStore = CCState.Store()
  private(set) var isWorking = false
  private(set) var mutationError: String?
  private(set) var sentCount = 0
  private(set) var requiresUpgrade = false
  private let client: APIClient
  private let didFail: @MainActor (Error) -> Void
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  // Only a confirmed send response or successful discard writes this snapshot. Reads never do.
  private let confirmed = CCState.State(Confirmed.none)
  private let reload: Command<Void, Void>
  private let confirm: Command<Void, ChatMailDraft?>
  @ObservationIgnored private var request: Task<ChatMailDraft?, Error>?
  @ObservationIgnored private var operation: Task<Void, Never>?
  private var closed = false

  init(id: String, client: APIClient, didFail: @escaping @MainActor (Error) -> Void) {
    self.id = id
    self.client = client
    self.didFail = didFail
    let revision = revision
    let confirmed = confirmed
    reload = Command { context in
      try context.set(confirmed, .none)
      try context.set(revision, update: { $0 + 1 })
    }
    confirm = Command { context, result in try context.set(confirmed, .result(result)) }
  }

  // Measurement rows may observe an already-acquired Task, but cannot start mail I/O.
  var hasRequestedValue: Bool { request != nil }

  @ObservationIgnored lazy var value = makeValue()

  private func makeValue() -> Computed<Task<ChatMailDraft?, Error>> {
    Computed { [weak self] get, options in
      guard let self, !closed, try get(lifetime) else { throw CancellationError() }
      _ = try get(revision)
      let snapshot = try get(confirmed)
      let signal = options.signal
      let task = Task<ChatMailDraft?, Error> { @MainActor [weak self, client, id] in
        do {
          try Task.checkCancellation()
          let result: ChatMailDraft?
          switch snapshot {
          case .none: result = try await client.mailDraft(id: id)
          case .result(let draft): result = draft
          }
          try Task.checkCancellation()
          try signal.checkCancellation()
          guard let self, !closed else { throw CancellationError() }
          return result
        } catch {
          if let self, !closed, !Task.isCancelled, !signal.isCancelled { report(error) }
          throw error
        }
      }
      request = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  /// Explicitly retry the read only; neither remount nor retry can send or discard email.
  func retry() {
    guard !closed, !requiresUpgrade, !isWorking else { return }
    invalidateRead()
  }

  func send() async { await mutate(.send) }
  func discard() async { await mutate(.discard) }

  private enum Mutation { case send, discard }

  private func mutate(_ mutation: Mutation) async {
    guard !closed, !requiresUpgrade, !isWorking, !Task.isCancelled else { return }
    isWorking = true
    mutationError = nil
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      defer {
        isWorking = false
        operation = nil
      }
      do {
        // Validate against the resource currently shown, never a second mutable read cache.
        guard let draft = try await stateStore.get(value).value,
          draft.status == .draft, draft.detailAvailable
        else { return }
        try Task.checkCancellation()
        guard !closed, !requiresUpgrade else { return }
        if mutation == .send && (draft.needsReconnect || draft.to.isEmpty) { return }
        // Fence any previously acquired read before publishing the confirmed write result.
        request?.cancel()
        switch mutation {
        case .send:
          let sent = try await client.sendMailDraft(id: id)
          try Task.checkCancellation()
          guard !closed else { return }
          try stateStore.set(confirm, sent)
          sentCount += 1
        case .discard:
          try await client.discardMailDraft(id: id)
          try Task.checkCancellation()
          guard !closed else { return }
          try stateStore.set(confirm, nil)
        }
      } catch {
        guard !closed, !Task.isCancelled else { return }
        switch (error as? APIClientError)?.statusCode {
        case 400 where mutation == .send:
          mutationError = String(
            localized: "The mail provider rejected this email. Check the recipients.")
        case 409 where mutation == .send:
          mutationError = String(localized: "This draft can no longer be sent.")
        default: mutationError = error.localizedDescription
        }
        report(error)
        // Read back an uncertain write, without ever replaying it. The read retains its own error.
        if !requiresUpgrade {
          invalidateRead()
          do {
            let readback = try stateStore.get(value)
            _ = await readback.result
          } catch { report(error) }
        }
      }
    }
    operation = task
    await task.value
  }

  private func invalidateRead() {
    request?.cancel()
    request = nil
    do { try stateStore.set(reload) } catch { report(error) }
  }

  private func report(_ error: Error) {
    if (error as? APIClientError)?.statusCode == 426 { requiresUpgrade = true }
    didFail(error)
  }

  func close() {
    guard !closed else { return }
    closed = true
    request?.cancel()
    request = nil
    operation?.cancel()
    operation = nil
    isWorking = false
    mutationError = nil
    do { try stateStore.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit {
    request?.cancel()
    operation?.cancel()
  }
}
