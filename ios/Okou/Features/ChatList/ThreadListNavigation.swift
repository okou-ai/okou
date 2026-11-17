import CCState
import ChatData
import ChatDomain
import Foundation
import Observation

/// Shared navigation confirmation, independent of thread-list and indicator reads.
@MainActor @Observable
final class ThreadListNavigation {
  private let resources: WorkspaceResources
  private let sync: ChatSync
  private let lifecycleTasks: LifecycleTasks
  private let didLoadAgents: @MainActor ([AgentRecord]) -> Void
  private let didFail: @MainActor (Error) -> Void
  private let didBlock: @MainActor () -> Void
  @ObservationIgnored private let confirmedAgents = CCState.State<[AgentRecord]>([])
  @ObservationIgnored private let replaceAgents: Command<Void, [AgentRecord]>
  let agentsValue: Computed<[AgentRecord]>
  @ObservationIgnored private var navigationSubscription: Subscription?
  @ObservationIgnored private var navigationPublication: Task<Void, Never>?
  private var navigationReadID = UUID()
  private var navigationRevision = 0
  private var restoredNavigation = false
  private var closed = false
  private var blocked = false

  init(
    resources: WorkspaceResources, sync: ChatSync, lifecycleTasks: LifecycleTasks,
    didLoadAgents: @escaping @MainActor ([AgentRecord]) -> Void,
    didFail: @escaping @MainActor (Error) -> Void, didBlock: @escaping @MainActor () -> Void
  ) {
    self.resources = resources
    self.sync = sync
    self.lifecycleTasks = lifecycleTasks
    self.didLoadAgents = didLoadAgents
    self.didFail = didFail
    self.didBlock = didBlock
    let confirmedAgents = confirmedAgents
    agentsValue = Computed { try $0(confirmedAgents) }
    replaceAgents = Command { context, value in try context.set(confirmedAgents, value) }
  }

  private var stateStore: CCState.Store { resources.store }
  private var navigationValue: Computed<Task<[AgentRecord], Error>> { resources.navigation }

  /// Confirmed navigation drives default-Agent decisions and the durable ChatSync baseline.
  /// Current read loading/errors belong exclusively to navigationValue.
  private(set) var agents: [AgentRecord] {
    get {
      access(keyPath: \.agents)
      return confirmed(agentsValue)
    }
    set {
      guard newValue != confirmed(agentsValue) else { return }
      withMutation(keyPath: \.agents) {
        do { try stateStore.set(replaceAgents, newValue) } catch {
          preconditionFailure("Cannot publish confirmed Agents: \(error)")
        }
      }
    }
  }

  func restoreCached() async {
    guard !closed, !Task.isCancelled else { return }
    if !restoredNavigation, navigationRevision == 0 {
      let revision = navigationRevision
      let cached = await sync.cachedNavigation()
      guard !closed, !Task.isCancelled else { return }
      if let cached, !restoredNavigation, navigationRevision == revision {
        agents = cached.agents
        didLoadAgents(agents)
      }
      restoredNavigation = true
    }
  }

  func refreshNavigation() async {
    guard !closed, !blocked, !Task.isCancelled else { return }
    await restoreCached()
    guard !closed, !blocked, !Task.isCancelled else { return }
    do {
      if navigationSubscription == nil {
        navigationSubscription = try stateStore.watch(navigationValue) { [weak self] in
          self?.confirmNavigation()
        }
        // watch establishes dependencies but does not initially invoke its listener.
        confirmNavigation()
      } else if navigationPublication == nil {
        try stateStore.set(resources.reloadNavigation)
      }
      // This waiter owns neither the shared I/O nor confirmed-snapshot publication.
      await navigationPublication?.value
    } catch is CancellationError {
    } catch { didFail(error) }
  }

  /// A workspace-owned subscriber reconciles successful reads to business/persistence state.
  /// SwiftUI observes navigationValue itself; this waiter never mirrors its loadable phase.
  private func confirmNavigation() {
    guard !closed, !blocked else { return }
    navigationPublication?.cancel()
    let id = UUID()
    navigationReadID = id
    do {
      let read = try stateStore.get(navigationValue)
      navigationPublication = Task { [weak self] in
        guard let self else { return }
        defer {
          if navigationReadID == id { navigationPublication = nil }
        }
        do {
          let value = try await read.value
          try Task.checkCancellation()
          guard !closed, !blocked, navigationReadID == id else { return }
          navigationRevision += 1
          agents = value
          didLoadAgents(value)
          await sync.persistNavigation(SidebarNavigationSnapshot(agents: value))
        } catch is CancellationError {
        } catch {
          guard !closed, !Task.isCancelled, navigationReadID == id else { return }
          blocked = (error as? APIClientError)?.statusCode == 426
          if blocked { didBlock() }
          didFail(error)
        }
      }
      if let navigationPublication { lifecycleTasks.track(navigationPublication) }
    } catch is CancellationError {
      navigationPublication = nil
    } catch { didFail(error) }
  }

  private func confirmed<Value>(_ signal: Signal<Value>) -> Value {
    // These are synchronous local business values, not a network or persistence boundary.
    do { return try stateStore.get(signal) } catch {
      preconditionFailure("Cannot read confirmed navigation: \(error)")
    }
  }

  func cancelNavigationPublication() {
    navigationReadID = UUID()
    navigationPublication?.cancel()
    navigationPublication = nil
    do { try navigationSubscription?.cancel() } catch { didFail(error) }
    navigationSubscription = nil
  }

  func close() {
    closed = true
    cancelNavigationPublication()
  }
}
