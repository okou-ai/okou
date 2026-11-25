import CCState
import ChatData
import Foundation

/// Confirmed Project names, membership operations and native list disclosure for one workspace.
/// The state lives in the workspace session's Store. The sidebar and the Project picker read
/// `presentation`, and the sidebar projection reads `confirmedValue`, through CCStateSwiftUI;
/// the synchronous accessors serve actions and tests.
@MainActor
final class ChatProjectStore {
  /// What the sidebar and the Project picker render.
  struct Presentation: Equatable {
    var projects: [ChatProject] = []
    /// The last failed Project action.
    var actionError: String?
    /// Mutation keys in flight: a Project ID, or `create`.
    var pending: Set<String> = []
    var expansion: [String: Bool] = [:]

    func isExpanded(_ id: String) -> Bool { expansion[id] ?? false }
  }

  /// Action and disclosure state beside the confirmed Projects.
  private struct Actions: Equatable {
    var error: String?
    var pending: Set<String> = []
    var expansion: [String: Bool] = [:]
  }

  private let lifecycleTasks: LifecycleTasks
  /// Confirmed names reconcile mutations and the durable baseline, independently of read phase.
  private let confirmedProjects = CCState.State<[ChatProject]>([])
  private let actionState = CCState.State(Actions())
  private let replaceProjects: Command<Void, [ChatProject]>
  let confirmedValue: Computed<[ChatProject]>
  let presentation: Computed<Presentation>
  private(set) var projects: [ChatProject] {
    get {
      do { return try stateStore.get(confirmedValue) } catch {
        preconditionFailure("Cannot read confirmed Projects: \(error)")
      }
    }
    set {
      do { try stateStore.set(replaceProjects, newValue) } catch {
        preconditionFailure("Cannot publish confirmed Projects: \(error)")
      }
    }
  }
  private(set) var active = false
  var actionError: String? { currentActions.error }
  var pending: Set<String> { currentActions.pending }
  /// The synchronous value of `presentation`, for a render whose graph read has not resolved.
  var currentPresentation: Presentation {
    let actions = currentActions
    return Presentation(
      projects: projects, actionError: actions.error, pending: actions.pending,
      expansion: actions.expansion)
  }
  private let service: ChatProjects
  private let resources: WorkspaceResources
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didChangeMembership: @MainActor () async -> Void
  private var publication: Task<Void, Never>?
  /// The list read the latest publication confirms; a repeated activation does not restart it.
  private var publishedRead: Task<[ChatProject], Error>?
  private var readID = UUID()
  private var restoredSnapshot = false
  private var tasks: [String: (id: UUID, task: Task<Void, Never>)] = [:]
  private var operations: [String: (payload: String, id: String)] = [:]
  private var revision = 0
  private var closed = false
  private var blocked = false
  private let disclosure: ProjectDisclosureStorage?
  private var restoredDisclosure = false
  private var hasConfirmedProjects = false
  private var disclosureTasks: [UUID: Task<Void, Never>] = [:]

  init(
    client: APIClient, resources: WorkspaceResources, sync: ChatSync,
    disclosure: ProjectDisclosureStorage? = nil,
    didFail: @escaping @MainActor (Error) -> Void,
    didChangeMembership: @escaping @MainActor () async -> Void,
    lifecycleTasks: LifecycleTasks? = nil
  ) {
    self.lifecycleTasks = lifecycleTasks ?? LifecycleTasks()
    let confirmedProjects = confirmedProjects
    let actionState = actionState
    confirmedValue = Computed { try $0(confirmedProjects) }
    presentation = Computed { get in
      let projects = try get(confirmedProjects)
      let actions = try get(actionState)
      return Presentation(
        projects: projects, actionError: actions.error, pending: actions.pending,
        expansion: actions.expansion)
    }
    replaceProjects = Command { context, value in
      guard try context.get(confirmedProjects) != value else { return }
      try context.set(confirmedProjects, value)
    }
    service = ChatProjects(client: client)
    self.resources = resources
    self.sync = sync
    self.disclosure = disclosure
    self.didFail = didFail
    self.didChangeMembership = didChangeMembership
  }

  func restore() async {
    guard !closed, !Task.isCancelled else { return }
    if !restoredDisclosure, let disclosure {
      do {
        let saved = try await disclosure.load().value
        try Task.checkCancellation()
        guard !closed else { return }
        let known = Set(projects.map(\.id))
        let restored = saved.filter { !hasConfirmedProjects || known.contains($0) }
        // A click during the disk read wins, including an explicit collapse.
        updateActions {
          $0.expansion = Dictionary(uniqueKeysWithValues: restored.map { ($0, true) })
            .merging($0.expansion) { _, current in current }
        }
        restoredDisclosure = true
      } catch is CancellationError {
        return
      } catch {
        guard !closed, !Task.isCancelled else { return }
        didFail(error)
      }
    }
    let previous = revision
    if !restoredSnapshot, let cached = await sync.cachedProjects(), !closed, previous == revision {
      projects = cached
      restoredSnapshot = true
    }
  }

  func isExpanded(_ id: String) -> Bool { currentActions.expansion[id] ?? false }

  /// Starts confirming the workspace's list read. This owner triggers every reload of that read
  /// (here and in `refresh`), so it continues each one itself instead of subscribing to it.
  func activate() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    do { try resources.retryProjects() } catch {
      didFail(error)
      return
    }
    active = true
    confirmProjects()
    await publication?.value
  }

  @discardableResult
  func toggle(_ id: String) -> Task<Void, Never>? {
    guard !closed else { return nil }
    let expanded = !isExpanded(id)
    updateActions { $0.expansion[id] = expanded }
    return persistDisclosure(id, expanded: expanded)
  }

  @discardableResult
  func expand(_ id: String) -> Task<Void, Never>? {
    guard !closed else { return nil }
    updateActions { $0.expansion[id] = true }
    return persistDisclosure(id, expanded: true)
  }

  private func persistDisclosure(_ id: String, expanded: Bool) -> Task<Void, Never>? {
    guard let disclosure else { return nil }
    return observeDisclosure(disclosure.setExpanded(expanded, projectID: id))
  }

  @discardableResult
  private func observeDisclosure(_ operation: Task<Void, Error>) -> Task<Void, Never> {
    let id = UUID()
    let task = Task { [weak self] in
      defer { self?.disclosureTasks[id] = nil }
      do {
        try await operation.value
        try Task.checkCancellation()
      } catch is CancellationError {
      } catch {
        guard let self, !closed, !Task.isCancelled else { return }
        didFail(error)
      }
    }
    lifecycleTasks.track(task)
    disclosureTasks[id] = task
    return task
  }

  var stateStore: CCState.Store { resources.store }
  var listValue: Computed<Task<[ChatProject], Error>> { resources.projectList }

  func refresh() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    guard active else {
      await activate()
      return
    }
    do {
      try stateStore.set(resources.reloadProjects)
      confirmProjects()
      await publication?.value
    } catch is CancellationError {
    } catch { didFail(error) }
  }

  /// Only confirmed business state is published here; views observe the original Task's phase.
  /// Each list read is confirmed once, as a subscription would on its invalidation.
  private func confirmProjects() {
    guard !closed, !blocked else { return }
    let read: Task<[ChatProject], Error>
    do { read = try stateStore.get(listValue) } catch is CancellationError {
      publication?.cancel()
      publication = nil
      return
    } catch {
      didFail(error)
      return
    }
    guard read != publishedRead else { return }
    publishedRead = read
    publication?.cancel()
    let id = UUID()
    readID = id
    let previous = revision
    publication = Task { [weak self] in
      guard let self else { return }
      defer { if readID == id { publication = nil } }
      do {
        let result = try await read.value
        try Task.checkCancellation()
        guard !closed, !blocked, readID == id, previous == revision, pending.isEmpty else {
          return
        }
        revision += 1
        projects = result
        restoredSnapshot = true
        hasConfirmedProjects = true
        let knownIDs = Set(result.map(\.id))
        updateActions { $0.expansion = $0.expansion.filter { knownIDs.contains($0.key) } }
        if let disclosure { observeDisclosure(disclosure.retainProjects(knownIDs)) }
        await sync.persistProjects(result)
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled, readID == id else { return }
        blocked = (error as? APIClientError)?.statusCode == 426
        didFail(error)
      }
    }
    if let publication { lifecycleTasks.track(publication) }
  }

  @discardableResult
  func create(name: String, fromThreadID: String? = nil) async -> ChatProject? {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.utf16.count <= 120 else { return nil }
    return await mutate(
      key: "create", payload: "\(name):\(fromThreadID ?? "")",
      body: { [service] eventID in
        try await service.create(name: name, eventID: eventID, fromThreadID: fromThreadID)
      },
      confirm: { [self] project in
        if !projects.contains(where: { $0.id == project.id }) { projects.append(project) }
        restoredSnapshot = true
        expand(project.id)
        await sync.persistProjects(projects)
        guard !closed, !Task.isCancelled else { return }
        if fromThreadID != nil { await didChangeMembership() }
      })
  }

  @discardableResult
  func rename(_ id: String, name: String) async -> Bool {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.utf16.count <= 120 else { return false }
    let project = await mutate(
      key: id, payload: "rename:\(name)",
      body: { [service] eventID in try await service.rename(id, name: name, eventID: eventID) },
      confirm: { [self] project in
        if let index = projects.firstIndex(where: { $0.id == id }) { projects[index] = project }
        await sync.persistProjects(projects)
      })
    return project != nil
  }

  func setArchived(_ id: String, archived: Bool) async {
    _ = await mutate(
      key: id, payload: "archive:\(archived)",
      body: { [service] eventID in
        try await service.setArchived(id, archived: archived, eventID: eventID)
      },
      confirm: { [self] project in
        if let index = projects.firstIndex(where: { $0.id == id }) { projects[index] = project }
        await sync.persistProjects(projects)
      })
  }

  @discardableResult
  func delete(_ id: String) async -> Bool {
    let result = await mutate(
      key: id, payload: "delete",
      body: { [service] eventID in try await service.delete(id, eventID: eventID) },
      confirm: { [self] _ in
        projects.removeAll { $0.id == id }
        // Retain a collapse overlay until an in-flight preference restore finishes.
        let restored = restoredDisclosure
        updateActions { $0.expansion[id] = restored ? nil : false }
        persistDisclosure(id, expanded: false)
        await sync.persistProjects(projects)
        guard !closed, !Task.isCancelled else { return }
        await didChangeMembership()
      })
    return result != nil
  }

  /// Failed explicit retries retain their operation identity; a changed intent gets a new one.
  private func mutate<Value: Sendable>(
    key: String, payload: String,
    body: @escaping @MainActor (String) async throws -> Value,
    confirm: @escaping @MainActor (Value) async -> Void
  ) async -> Value? {
    guard !closed, !blocked, !pending.contains(key), !Task.isCancelled else { return nil }
    let previous = operations[key]
    let id: String
    if let previous, previous.payload == payload {
      id = previous.id
    } else {
      id = ChatProjects.operationID()
    }
    operations[key] = (payload, id)
    updateActions { $0.pending.insert(key) }
    revision += 1
    publication?.cancel()
    let taskID = UUID()
    var result: Value?
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if tasks[key]?.id == taskID {
          updateActions { $0.pending.remove(key) }
          tasks[key] = nil
        }
      }
      do {
        let value = try await body(id)
        try Task.checkCancellation()
        guard !closed else { return }
        revision += 1
        operations[key] = nil
        updateActions { $0.error = nil }
        // Confirmation and persistence belong to the workspace, not its departing UI waiter.
        await confirm(value)
        try Task.checkCancellation()
        guard !closed else { return }
        updateActions { $0.pending.remove(key) }
        await refresh()
        result = value
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return }
        updateActions { $0.error = error.localizedDescription }
        blocked = (error as? APIClientError)?.statusCode == 426
        didFail(error)
      }
    }
    lifecycleTasks.track(task)
    tasks[key] = (taskID, task)
    await task.value
    return result
  }

  func dismissError() { updateActions { $0.error = nil } }

  func close() {
    closed = true
    readID = UUID()
    publication?.cancel()
    publication = nil
    publishedRead = nil
    for entry in tasks.values { entry.task.cancel() }
    for task in disclosureTasks.values { task.cancel() }
    disclosureTasks.removeAll()
    // Storage owns accepted disk mutations; UI teardown cancels only their waiters.
    _ = disclosure?.close()
  }

  private var currentActions: Actions {
    do { return try stateStore.get(actionState) } catch {
      preconditionFailure("Cannot read the Project action state: \(error)")
    }
  }

  private func updateActions(_ mutation: (inout Actions) -> Void) {
    let previous = currentActions
    var next = previous
    mutation(&next)
    guard next != previous else { return }
    do { try stateStore.set(actionState, next) } catch {
      preconditionFailure("Cannot update the Project action state: \(error)")
    }
  }
}
