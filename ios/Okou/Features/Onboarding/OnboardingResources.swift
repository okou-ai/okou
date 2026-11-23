import CCState
import ChatData
import Foundation

/// Each resource keeps its own failure/retry, under one authenticated owner.
@MainActor
final class OnboardingResources {
  enum Resource: CaseIterable, Hashable {
    case status, draft, sources, preferences, tools, recommendation
  }
  let store = CCState.Store()
  let service: OnboardingService
  private let catalog: OnboardingToolCatalog
  private let locale: String
  private let revisions = Dictionary(
    uniqueKeysWithValues: Resource.allCases.map { ($0, CCState.State(0)) })
  private let alive = CCState.State(true)
  private var cancellations: [Resource: () -> Void] = [:]
  private let jobID = CCState.State<String?>(nil)
  private let didFail: @MainActor (Error) -> Void

  init(
    client: APIClient, catalogURL: URL, locale: String,
    didFail: @escaping @MainActor (Error) -> Void
  ) {
    service = OnboardingService(client: client)
    catalog = OnboardingToolCatalog(url: catalogURL)
    self.locale = locale
    self.didFail = didFail
  }

  lazy var status = read(.status) { [service] in try await service.status() }
  lazy var draft = read(.draft) { [service] in try await service.draft() }
  lazy var sources = read(.sources) { [service] in try await service.sources() }
  lazy var preferences = read(.preferences) { [service] in try await service.toolPreferences() }
  lazy var tools = read(.tools) { [catalog, locale] in try await catalog.tools(locale: locale) }
  lazy var recommendation = makeRecommendation()

  private func makeRecommendation() -> Computed<Task<OnboardingRecommendation?, Error>> {
    Computed { [weak self] get, options in
      guard let self, try get(alive) else { throw CancellationError() }
      _ = try get(revisions[.recommendation]!)
      let id = try get(jobID)
      let signal = options.signal
      let task = Task { @MainActor [service] in
        guard let id else { return nil as OnboardingRecommendation? }
        let value = try await service.recommendation(id)
        try Task.checkCancellation()
        try signal.checkCancellation()
        return value
      }
      cancellations[.recommendation] = { task.cancel() }
      signal.onCancel { task.cancel() }
      return task
    }
  }

  private func read<Value: Sendable>(
    _ resource: Resource, load: @escaping @Sendable () async throws -> Value
  ) -> Computed<Task<Value, Error>> {
    Computed { [weak self] get, options in
      guard let self, try get(alive) else { throw CancellationError() }
      _ = try get(revisions[resource]!)
      let signal = options.signal
      let task = Task { @MainActor [didFail] in
        do {
          let value = try await load()
          try Task.checkCancellation()
          try signal.checkCancellation()
          return value
        } catch {
          if !Task.isCancelled, !signal.isCancelled { didFail(error) }
          throw error
        }
      }
      cancellations[resource] = { task.cancel() }
      signal.onCancel { task.cancel() }
      return task
    }
  }

  func retry(_ resource: Resource) throws {
    guard try store.get(alive) else { throw CancellationError() }
    cancellations[resource]?()
    try store.set(revisions[resource]!, update: { $0 + 1 })
  }

  func showRecommendation(_ id: String?) throws {
    try store.set(jobID, id)
  }

  func close() {
    for cancel in cancellations.values { cancel() }
    cancellations = [:]
    do { try store.set(alive, false) } catch { didFail(error) }
  }

  isolated deinit { for cancel in cancellations.values { cancel() } }
}
