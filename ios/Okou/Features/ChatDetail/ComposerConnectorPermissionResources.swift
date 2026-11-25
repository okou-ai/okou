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

  struct Draft: Equatable, Sendable {
    var edits: [String: ChatPermissionEdit] = [:]
    var resetsDefaults = false
    var hasChanges: Bool { resetsDefaults || !edits.isEmpty }
  }

  struct Controls: Sendable {
    let selection: Selection
    let confirmationFailure: String?
    let hasChanges: Bool
  }

  struct Page: Sendable {
    let state: ChatConnectorPermissionState
    let permissions: [ChatPermissionMetadata.Permission]
    let draft: Draft

    func policy(for name: String) -> ChatPermissionMetadata.Policy {
      if let edit = draft.edits[name] { return edit.action == "allow" ? .allow : .deny }
      return state.metadata.policy(
        for: name, grants: draft.resetsDefaults ? [] : state.grants, at: .now)
    }

    func summary(for names: [String]) -> String {
      let policies = Set(names.map { policy(for: $0).rawValue })
      if policies.count == 1, let policy = policies.first { return policy.capitalized }
      return String(localized: "Mixed")
    }

    func expiry(for name: String) -> String? {
      if let edit = draft.edits[name] {
        guard edit.action == "allow" else { return nil }
        switch edit.expiresIn {
        case "1h": return String(localized: "For 1 hour")
        case "24h": return String(localized: "For 24 hours")
        case "7d": return String(localized: "For 7 days")
        default: return String(localized: "Always")
        }
      }
      guard !draft.resetsDefaults,
        let grant = state.grants.last(where: { $0.permission == name && $0.isActive(at: .now) })
      else { return nil }
      guard let expiry = grant.expiresAt else { return String(localized: "Always") }
      return String(localized: "Expires \(expiry.formatted(date: .abbreviated, time: .shortened))")
    }
  }

  enum Action: Sendable {
    case allow(String)
    case deny(String)
    case allowListed, denyListed, reset
    case allowGroup([String])
    case denyGroup([String])
  }

  private struct Change {
    let search: String?
    let category: String?
    let duration: String?
  }

  let slug: String
  let label: String
  /// The composer's Store, the workspace session's in production.
  let store: CCState.Store
  let controls: Computed<Controls>
  private let input = CCState.State(Selection())
  private let confirmationFailure = CCState.State<String?>(nil)
  private let draft = CCState.State(Draft())
  private let stage: Command<Void, Draft>
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
    composer: ComposerConnectorStore, slug: String, label: String,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.composer = composer
    self.slug = slug
    self.label = label
    store = composer.graph
    service = composer.service
    self.didFail = didFail
    let input = input
    let confirmationFailure = confirmationFailure
    let revision = revision
    let draft = draft
    stage = Command { context, value in try context.set(draft, value) }
    controls = Computed { get in
      Controls(
        selection: try get(input), confirmationFailure: try get(confirmationFailure),
        hasChanges: try get(draft).hasChanges)
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
      let task: Task<ChatConnectorPermissionState, Error> =
        Task { @MainActor [weak self, service, slug] in
          do {
            try Task.checkCancellation()
            let result = try await service.permissions(slug: slug)
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
    computedTask { [read, input, draft] get, options in
      let draft = try get(draft)
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
      return Page(state: state, permissions: permissions, draft: draft)
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
      case .allowGroup(let names):
        edits = names.filter { value.state.metadata.contains($0) }.map {
          ChatPermissionEdit(permission: $0, action: "allow", expiresIn: selection.duration)
        }
      case .denyGroup(let names):
        edits = names.filter { value.state.metadata.contains($0) }.map {
          ChatPermissionEdit(permission: $0, action: "deny")
        }
      case .reset: edits = []
      }
      let reset: Bool
      if case .reset = action { reset = true } else { reset = false }
      guard reset || !edits.isEmpty else { return }
      guard edits.allSatisfy({ value.state.metadata.contains($0.permission) }) else { return }
      var next = reset ? Draft(edits: [:], resetsDefaults: true) : try store.get(draft)
      for edit in edits { next.edits[edit.permission] = edit }
      try store.set(stage, next)
    } catch { if !closed, !Task.isCancelled { didFail(error) } }
  }

  /// Closing this editor discards its draft; only this action submits it.
  func save() async -> Bool {
    guard !closed, !Task.isCancelled, let composer, composer.permissions === self else {
      return false
    }
    do {
      let pending = try store.get(draft)
      guard pending.hasChanges else { return true }
      let edits = pending.edits.values.sorted { $0.permission < $1.permission }
      guard
        await composer.applyPermissions(
          owner: self, edits: edits, reset: pending.resetsDefaults), !closed
      else { return false }
      _ = try await store.get(read).value
      try Task.checkCancellation()
      guard !closed else { return false }
      try store.set(stage, Draft())
      return true
    } catch {
      if !closed, !Task.isCancelled { didFail(error) }
      return false
    }
  }

  func close() {
    closed = true
    current?.cancel()
    current = nil
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }

  isolated deinit { current?.cancel() }
}
