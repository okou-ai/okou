import ChatData
import ChatDomain
import Foundation
import Observation

/// Search lifetime is owned by one workspace and one presentation, including debounce and cancellation.
@MainActor @Observable
final class ChatSearchStore {
  private(set) var isPresented = false
  private(set) var query = ""
  private(set) var messages: [ChatSearchResult] = []
  private(set) var isLoading = false
  private(set) var error: String?
  /// Every workflow the person can see, loaded once per presentation and filtered locally.
  private(set) var allWorkflows: [ChatSearchWorkflow] = []
  private(set) var isLoadingWorkflows = false
  private(set) var workflowsError: String?
  /// Artifacts are searched on the server with the same pause as messages.
  private(set) var artifacts: [ChatSearchArtifact] = []
  private(set) var isLoadingArtifacts = false
  private(set) var artifactsError: String?
  private var workflowsTask: Task<Void, Never>?
  private(set) var openingError: String?
  private let sync: ChatSync
  private let didFail: @MainActor (Error) -> Void
  private var task: Task<Void, Never>?
  private var generation = UUID()
  private var closed = false

  init(sync: ChatSync, didFail: @escaping @MainActor (Error) -> Void) {
    self.sync = sync
    self.didFail = didFail
  }

  var keyword: String { query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

  func titleResults(in threads: [ChatThread]) -> [ChatThread] {
    let query = keyword
    let matching = threads.filter { query.isEmpty || $0.displayTitle.lowercased().contains(query) }
    if query.isEmpty { return Array(matching.prefix(25)) }
    return Array(
      matching.sorted { $0.sortAt == $1.sortAt ? $0.id > $1.id : $0.sortAt > $1.sortAt }.prefix(25))
  }

  var workflows: [ChatSearchWorkflow] { allWorkflows.filter { $0.matches(keyword) } }

  func present() {
    guard !closed else { return }
    isPresented = true
    loadWorkflows()
  }

  func retryWorkflows() { loadWorkflows() }

  private func loadWorkflows() {
    workflowsTask?.cancel()
    workflowsError = nil
    isLoadingWorkflows = true
    workflowsTask = Task { [weak self] in
      guard let self else { return }
      do {
        let result = try await sync.searchWorkflows()
        guard !closed, isPresented, !Task.isCancelled else { return }
        allWorkflows = result
        isLoadingWorkflows = false
      } catch is CancellationError {
      } catch {
        guard !closed, isPresented, !Task.isCancelled else { return }
        workflowsError = error.localizedDescription
        isLoadingWorkflows = false
      }
    }
  }

  func updateQuery(_ value: String) {
    guard value != query else { return }
    query = value
    runSearch()
  }

  func retry() { runSearch() }

  private func runSearch() {
    generation = UUID()
    task?.cancel()
    task = nil
    messages = []
    error = nil
    artifacts = []
    artifactsError = nil
    openingError = nil
    isLoading = false
    isLoadingArtifacts = false
    let keyword = keyword
    guard isPresented, !closed, !keyword.isEmpty else { return }
    isLoading = true
    isLoadingArtifacts = true
    let generation = generation
    task = Task { [weak self] in
      guard let self else { return }
      do {
        try await Task.sleep(for: .milliseconds(300))
      } catch { return }
      // Messages and artifacts arrive independently; one failing leaves the other's results.
      async let messageResults: Void = searchMessages(keyword, generation)
      async let artifactResults: Void = searchArtifacts(keyword, generation)
      _ = await (messageResults, artifactResults)
    }
  }

  private func searchMessages(_ keyword: String, _ generation: UUID) async {
    do {
      let result = try await sync.searchMessages(keyword: keyword)
      guard canApply(generation) else { return }
      messages = result
      isLoading = false
    } catch is CancellationError {
    } catch {
      guard canApply(generation) else { return }
      self.error = error.localizedDescription
      isLoading = false
      didFail(error)
    }
  }

  private func searchArtifacts(_ keyword: String, _ generation: UUID) async {
    do {
      let result = try await sync.searchArtifacts(keyword: keyword)
      guard canApply(generation) else { return }
      artifacts = result
      isLoadingArtifacts = false
    } catch is CancellationError {
    } catch {
      guard canApply(generation) else { return }
      artifactsError = error.localizedDescription
      isLoadingArtifacts = false
    }
  }

  private func canApply(_ generation: UUID) -> Bool {
    !closed && isPresented && !Task.isCancelled && self.generation == generation
  }

  var requestID: UUID { generation }

  func ownsPresentation(_ id: UUID) -> Bool { isPresented && !closed && generation == id }

  func setOpeningError(_ value: String?) { openingError = value }

  func dismiss() {
    generation = UUID()
    task?.cancel()
    task = nil
    workflowsTask?.cancel()
    workflowsTask = nil
    isPresented = false
    query = ""
    messages = []
    isLoading = false
    error = nil
    artifacts = []
    isLoadingArtifacts = false
    artifactsError = nil
    allWorkflows = []
    isLoadingWorkflows = false
    workflowsError = nil
    openingError = nil
  }

  func close() {
    dismiss()
    closed = true
  }
}
