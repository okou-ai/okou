import CCState
import ChatData
import Foundation
import Observation

/// Confirmed Project names, membership operations and native list disclosure for one workspace.
@MainActor @Observable
final class ChatProjectStore {
  // The confirmed baseline also serves persistence and business decisions. The graph
  // stores it once; request loading/errors remain with their existing read owner.
  @ObservationIgnored private let confirmedProjects = CCState.State<[ChatProject]>([])
  @ObservationIgnored let projectsValue: Computed<[ChatProject]>
  @ObservationIgnored private var projectsSubscription: Subscription?
  private(set) var projects: [ChatProject] {
    get {
      access(keyPath: \.projects)
      // Only a synchronous local atom is read here, never external I/O.
      do { return try resources.store.get(projectsValue) } catch {
        preconditionFailure("Cannot read confirmed projects: \(error)")
      }
    }
    set {
      guard !closed, projects != newValue else { return }
      do { try resources.store.set(confirmedProjects, newValue) } catch {
        preconditionFailure("Cannot publish confirmed projects: \(error)")
      }
    }
  }
  private(set) var hasLoaded = false
  private(set) var active = false
  private(set) var readError: String?
  private(set) var actionError: String?
  private(set) var pending: Set<String> = []
  private(set) var expansion: [String: Bool] = [:]
  private(set) var limits: [String: Int] = [:]
  private let service: ChatProjects
  private let resources: WorkspaceResources
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didChangeMembership: @MainActor () async -> Void
  private var refreshTask: Task<Void, Never>?
  private var refreshAgain = false
  private var tasks: [String: Task<Void, Never>] = [:]
  private var operations: [String: (payload: String, id: String)] = [:]
  private var revision = 0
  private var closed = false
  private var blocked = false
  private var expansionKey: String?
  private let defaults: UserDefaults

  init(
    client: APIClient, resources: WorkspaceResources, sync: ChatSync,
    defaults: UserDefaults = .standard,
    didFail: @escaping @MainActor (Error) -> Void,
    didChangeMembership: @escaping @MainActor () async -> Void
  ) {
    service = ChatProjects(client: client)
    self.resources = resources
    self.sync = sync
    self.defaults = defaults
    self.didFail = didFail
    self.didChangeMembership = didChangeMembership
    let confirmed = confirmedProjects
    projectsValue = Computed { get in try get(confirmed) }
    do {
      projectsSubscription = try resources.store.watch(projectsValue) { [weak self] in
        guard let self else { return }
        withMutation(keyPath: \.projects) {}
      }
    } catch { preconditionFailure("Cannot observe confirmed projects: \(error)") }
  }

  func restore(userID: String, workspaceID: String, apiURL: URL) async {
    guard !closed else { return }
    let key = "project-expansion:\(apiURL.absoluteString):\(userID):\(workspaceID)"
    if expansionKey != key {
      expansionKey = key
      expansion = defaults.dictionary(forKey: key) as? [String: Bool] ?? [:]
    }
    let previous = revision
    if !hasLoaded, let cached = await sync.cachedProjects(), !closed, previous == revision {
      projects = cached
      hasLoaded = true
    }
  }

  func isExpanded(_ id: String) -> Bool { expansion[id] ?? false }
  func limit(for id: String) -> Int { limits[id] ?? 20 }

  func showMore(_ id: String) { limits[id] = limit(for: id) + 20 }

  func activate() async {
    guard !active, !closed else { return }
    active = true
    await refresh()
  }

  func toggle(_ id: String) {
    guard !closed else { return }
    expansion[id] = !isExpanded(id)
    persistExpansion()
  }

  func expand(_ id: String) {
    guard !closed else { return }
    expansion[id] = true
    persistExpansion()
  }

  private func persistExpansion() {
    if let expansionKey { defaults.set(expansion, forKey: expansionKey) }
  }

  func refresh() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    if let refreshTask {
      refreshAgain = true
      await refreshTask.value
      return
    }
    let task = Task { [weak self] in
      guard let self else { return }
      defer { refreshTask = nil }
      repeat {
        refreshAgain = false
        let previous = revision
        do {
          let read = try resources.projectList(refresh: true)
          let result = try await read.value
          try Task.checkCancellation()
          guard !closed else { return }
          if previous != revision {
            refreshAgain = true
            continue
          }
          projects = result
          hasLoaded = true
          readError = nil
          let knownIDs = Set(result.map(\.id))
          expansion = expansion.filter { knownIDs.contains($0.key) }
          limits = limits.filter { knownIDs.contains($0.key) }
          persistExpansion()
          await sync.persistProjects(result)
        } catch is CancellationError {
          return
        } catch {
          guard !closed, !Task.isCancelled else { return }
          readError = error.localizedDescription
          blocked = (error as? APIClientError)?.statusCode == 426
          didFail(error)
        }
      } while refreshAgain && !closed && !blocked && !Task.isCancelled
    }
    refreshTask = task
    await task.value
  }

  @discardableResult
  func create(name: String, fromThreadID: String? = nil) async -> ChatProject? {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.utf16.count <= 120 else { return nil }
    let project = await mutate(key: "create", payload: "\(name):\(fromThreadID ?? "")") {
      [service] eventID in
      try await service.create(name: name, eventID: eventID, fromThreadID: fromThreadID)
    }
    guard let project, !closed else { return nil }
    if !projects.contains(where: { $0.id == project.id }) { projects.append(project) }
    hasLoaded = true
    expand(project.id)
    await sync.persistProjects(projects)
    if fromThreadID != nil { await didChangeMembership() }
    await refresh()
    return project
  }

  @discardableResult
  func rename(_ id: String, name: String) async -> Bool {
    let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty, name.utf16.count <= 120 else { return false }
    let project = await mutate(key: id, payload: "rename:\(name)") { [service] eventID in
      try await service.rename(id, name: name, eventID: eventID)
    }
    guard let project, !closed else { return false }
    if let index = projects.firstIndex(where: { $0.id == id }) { projects[index] = project }
    await sync.persistProjects(projects)
    await refresh()
    return true
  }

  @discardableResult
  func delete(_ id: String) async -> Bool {
    let result = await mutate(key: id, payload: "delete") { [service] eventID in
      try await service.delete(id, eventID: eventID)
    }
    guard result != nil, !closed else { return false }
    projects.removeAll { $0.id == id }
    expansion[id] = nil
    persistExpansion()
    await sync.persistProjects(projects)
    await didChangeMembership()
    await refresh()
    return true
  }

  @discardableResult
  func move(threadID: String, projectID: String?) async -> Bool {
    let result = await mutate(key: threadID, payload: "move:\(projectID ?? "")") {
      [service] eventID in
      try await service.move(threadID: threadID, projectID: projectID, eventID: eventID)
    }
    guard result != nil, !closed else { return false }
    if let projectID { expand(projectID) }
    await didChangeMembership()
    return true
  }

  /// Failed explicit retries retain their operation identity; a changed intent gets a new one.
  private func mutate<Value: Sendable>(
    key: String, payload: String,
    body: @escaping @MainActor (String) async throws -> Value
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
    pending.insert(key)
    revision += 1
    var result: Value?
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        pending.remove(key)
        tasks[key] = nil
      }
      do {
        let value = try await body(id)
        try Task.checkCancellation()
        guard !closed else { return }
        revision += 1
        operations[key] = nil
        actionError = nil
        result = value
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return }
        actionError = error.localizedDescription
        blocked = (error as? APIClientError)?.statusCode == 426
        didFail(error)
      }
    }
    tasks[key] = task
    await task.value
    return result
  }

  func dismissError() { actionError = nil }

  func close() {
    closed = true
    stopObservingProjects()
    refreshTask?.cancel()
    for task in tasks.values { task.cancel() }
  }

  private func stopObservingProjects() {
    do { try projectsSubscription?.cancel() } catch {
      preconditionFailure("Cannot release confirmed projects: \(error)")
    }
    projectsSubscription = nil
  }

  isolated deinit { stopObservingProjects() }
}
