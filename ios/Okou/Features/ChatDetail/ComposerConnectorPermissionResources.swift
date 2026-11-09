import CCState
import ChatData
import Foundation

/// The presented permission editor owns reads; committed writes remain with the composer.
@MainActor
final class ComposerConnectorPermissionResources {
  struct Selection: Equatable, Sendable {
    var search = ""
    var category = ""
    var duration = "1h"
  }

  struct Controls: Sendable {
    let selection: Selection
    let confirmationFailure: String?
  }

  struct Page: Sendable {
    let state: ChatConnectorPermissionState
    let permissions: [ChatPermissionMetadata.Permission]
  }

  enum Action: Sendable {
    case allow(String)
    case deny(String)
    case allowListed, denyListed, reset
  }

  private struct Change {
    let search: String?
    let category: String?
    let duration: String?
  }

  let agentID: String
  let slug: String
  let label: String
  let store = CCState.Store()
  let controls: Computed<Controls>
  private let input = CCState.State(Selection())
  private let confirmationFailure = CCState.State<String?>(nil)
  private let revision = CCState.State(0)
  private let lifetime = CCState.State(true)
  private let change: Command<Void, Change>
  private let reload: Command<Void, Void>
  private let reportConfirmation: Command<Void, String?>
  private let service: ChatComposerAccess
  private let didFail: @MainActor (Error) -> Void
  private weak var composer: ComposerConnectorStore?
  private var current: Task<ChatConnectorPermissionState, Error>?
  private var closed = false

  init(
    composer: ComposerConnectorStore, agentID: String, slug: String, label: String,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.composer = composer
    self.agentID = agentID
    self.slug = slug
    self.label = label
    service = composer.service
    self.didFail = didFail
    let input = input
    let confirmationFailure = confirmationFailure
    let revision = revision
    controls = Computed { get in
      Controls(selection: try get(input), confirmationFailure: try get(confirmationFailure))
    }
    change = Command { context, change in
      let previous = try context.get(input)
      var next = previous
      if let search = change.search { next.search = search }
      if let category = change.category { next.category = category }
      if let duration = change.duration { next.duration = duration }
      if previous != next { try context.set(input, next) }
    }
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
    reportConfirmation = Command { context, error in try context.set(confirmationFailure, error) }
  }

  private lazy var read = makeRead()

  private func makeRead() -> Computed<Task<ChatConnectorPermissionState, Error>> {
    Computed { [weak self] get, options in
      guard let self, try get(lifetime), !closed else { throw CancellationError() }
      _ = try get(revision)
      let signal = options.signal
      let task = Task<ChatConnectorPermissionState, Error> {
        @MainActor [weak self, service, agentID, slug] in
        do {
          try Task.checkCancellation()
          let result = try await service.permissions(slug: slug, agentID: agentID)
          try Task.checkCancellation()
          try signal.checkCancellation()
          return result
        } catch {
          if let self, !closed, !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      current = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  lazy var page = makePage()

  private func makePage() -> Computed<Task<Page, Error>> {
    computedTask { [read, input] get, options in
      let selection = try get(input)
      let state = try await get(read).value
      try Task.checkCancellation()
      try options.signal.checkCancellation()
      let permissions = state.metadata.permissions.filter {
        (selection.category.isEmpty
          || state.metadata.categories?.categories[$0.name] == selection.category)
          && (selection.search.isEmpty || $0.name.localizedCaseInsensitiveContains(selection.search)
            || $0.description?.localizedCaseInsensitiveContains(selection.search) == true)
      }
      return Page(state: state, permissions: permissions)
    }
  }

  func update(search: String? = nil, category: String? = nil, duration: String? = nil) {
    guard !closed else { return }
    do {
      try store.set(change, Change(search: search, category: category, duration: duration))
    } catch { didFail(error) }
  }

  func retry() async {
    guard !closed, let composer else { return }
    await composer.refresh()
    await refresh()
  }

  func refresh() async {
    guard !closed, !Task.isCancelled else { return }
    do {
      try store.set(reload)
      _ = await (try store.get(read)).result
      guard !closed else { return }
      let failure =
        composer?.uncertain == true
        ? composer?.error
          ?? String(localized: "Refresh Connectors to confirm the saved permissions.") : nil
      try store.set(reportConfirmation, failure)
    } catch { didFail(error) }
  }

  func apply(_ action: Action) async {
    guard !closed, !Task.isCancelled, let composer, composer.permissions === self else { return }
    do {
      let selection = try store.get(input)
      guard case .success(let value) = await (try store.get(page)).result else { return }
      guard !closed, !Task.isCancelled else { return }
      let edits: [ChatPermissionEdit]
      switch action {
      case .allow(let name):
        edits = [
          ChatPermissionEdit(permission: name, action: "allow", expiresIn: selection.duration)
        ]
      case .deny(let name):
        edits = [ChatPermissionEdit(permission: name, action: "deny")]
      case .allowListed:
        edits = value.permissions.map {
          ChatPermissionEdit(permission: $0.name, action: "allow", expiresIn: selection.duration)
        }
      case .denyListed:
        edits = value.permissions.map { ChatPermissionEdit(permission: $0.name, action: "deny") }
      case .reset: edits = []
      }
      let reset: Bool
      if case .reset = action { reset = true } else { reset = false }
      guard reset || !edits.isEmpty else { return }
      await composer.applyPermissions(owner: self, edits: edits, reset: reset)
    } catch { if !closed, !Task.isCancelled { didFail(error) } }
  }

  func close() {
    closed = true
    current?.cancel()
    current = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit { current?.cancel() }
}
