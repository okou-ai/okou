import CCState
import ChatData
import Foundation
import Observation

/// Confirmed Project names, membership operations and native list disclosure for one workspace.
@MainActor @Observable
final class ChatProjectStore {
  /// Confirmed names reconcile mutations and the durable baseline, independently of read phase.
  @ObservationIgnored private let confirmedProjects = CCState.State<[ChatProject]>([])
  @ObservationIgnored private let replaceProjects: Command<Void, [ChatProject]>
  let confirmedValue: Computed<[ChatProject]>
  private(set) var projects: [ChatProject] {
    get {
      access(keyPath: \.projects)
      do { return try stateStore.get(confirmedValue) } catch {
        preconditionFailure("Cannot read confirmed Projects: \(error)")
      }
    }
    set {
      withMutation(keyPath: \.projects) {
        do { try stateStore.set(replaceProjects, newValue) } catch {
          preconditionFailure("Cannot publish confirmed Projects: \(error)")
        }
      }
    }
  }
  private(set) var active = false
  private(set) var actionError: String?
  private(set) var pending: Set<String> = []
  private(set) var expansion: [String: Bool] = [:]
  private(set) var limits: [String: Int] = [:]
  private let service: ChatProjects
  private let resources: WorkspaceResources
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private let didChangeMembership: @MainActor () async -> Void
  @ObservationIgnored private var subscription: Subscription?
  @ObservationIgnored private var publication: Task<Void, Never>?
  private var readID = UUID()
  private var restoredSnapshot = false
  private var tasks: [String: (id: UUID, task: Task<Void, Never>)] = [:]
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
    let confirmedProjects = confirmedProjects
    confirmedValue = Computed { try $0(confirmedProjects) }
    replaceProjects = Command { context, value in
      guard try context.get(confirmedProjects) != value else { return }
      try context.set(confirmedProjects, value)
    }
    service = ChatProjects(client: client)
    self.resources = resources
    self.sync = sync
    self.defaults = defaults
    self.didFail = didFail
    self.didChangeMembership = didChangeMembership
  }

  func restore(userID: String, workspaceID: String, apiURL: URL) async {
    guard !closed else { return }
    let key = "project-expansion:\(apiURL.absoluteString):\(userID):\(workspaceID)"
    if expansionKey != key {
      expansionKey = key
      expansion = defaults.dictionary(forKey: key) as? [String: Bool] ?? [:]
    }
    let previous = revision
    if !restoredSnapshot, let cached = await sync.cachedProjects(), !closed, previous == revision {
      projects = cached
      restoredSnapshot = true
    }
  }

  func isExpanded(_ id: String) -> Bool { expansion[id] ?? false }
  func limit(for id: String) -> Int { limits[id] ?? 20 }

  func showMore(_ id: String) { limits[id] = limit(for: id) + 20 }

  func activate() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    if !active {
      do {
        subscription = try stateStore.watch(listValue) { [weak self] in
          self?.confirmProjects()
        }
        active = true
        confirmProjects()
      } catch is CancellationError {
      } catch { didFail(error) }
    }
    await publication?.value
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
      await publication?.value
    } catch is CancellationError {
    } catch { didFail(error) }
  }

  /// Only confirmed business state is published here; views observe the original Task's phase.
  private func confirmProjects() {
    guard !closed, !blocked else { return }
    publication?.cancel()
    let id = UUID()
    readID = id
    let previous = revision
    do {
      let read = try stateStore.get(listValue)
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
          let knownIDs = Set(result.map(\.id))
          expansion = expansion.filter { knownIDs.contains($0.key) }
          limits = limits.filter { knownIDs.contains($0.key) }
          persistExpansion()
          await sync.persistProjects(result)
        } catch is CancellationError {
        } catch {
          guard !closed, !Task.isCancelled, readID == id else { return }
          blocked = (error as? APIClientError)?.statusCode == 426
          didFail(error)
        }
      }
    } catch is CancellationError {
      publication = nil
    } catch { didFail(error) }
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

  @discardableResult
  func delete(_ id: String) async -> Bool {
    let result = await mutate(
      key: id, payload: "delete",
      body: { [service] eventID in try await service.delete(id, eventID: eventID) },
      confirm: { [self] _ in
        projects.removeAll { $0.id == id }
        expansion[id] = nil
        limits[id] = nil
        persistExpansion()
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
    pending.insert(key)
    revision += 1
    publication?.cancel()
    let taskID = UUID()
    var result: Value?
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if tasks[key]?.id == taskID {
          pending.remove(key)
          tasks[key] = nil
        }
      }
      do {
        let value = try await body(id)
        try Task.checkCancellation()
        guard !closed else { return }
        revision += 1
        operations[key] = nil
        actionError = nil
        // Confirmation and persistence belong to the workspace, not its departing UI waiter.
        await confirm(value)
        try Task.checkCancellation()
        guard !closed else { return }
        pending.remove(key)
        await refresh()
        result = value
      } catch is CancellationError {
      } catch {
        guard !closed, !Task.isCancelled else { return }
        actionError = error.localizedDescription
        blocked = (error as? APIClientError)?.statusCode == 426
        didFail(error)
      }
    }
    tasks[key] = (taskID, task)
    await task.value
    return result
  }

  func dismissError() { actionError = nil }

  func close() {
    closed = true
    readID = UUID()
    publication?.cancel()
    publication = nil
    do { try subscription?.cancel() } catch { didFail(error) }
    subscription = nil
    for entry in tasks.values { entry.task.cancel() }
  }
}
