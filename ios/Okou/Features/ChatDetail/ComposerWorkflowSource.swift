import ChatData
import ChatDomain
import Foundation
import OSLog

/// This object belongs to one immutable account/workspace scope.
@MainActor
final class ComposerWorkflowSource {
  /// One slash menu's candidates and the recently used order that ranks them.
  struct Catalog: Sendable {
    let workflows: [ComposerWorkflow]
    let recent: [String]
  }

  let id = UUID()
  private let client: APIClient
  private let storage: ChatDraftStorage?
  private var recent: [String] = []
  /// Advances with each accepted use so an older server read cannot replace its promotion.
  private var recentRevision = 0
  /// Accepted uses that the single serial write sends in acceptance order.
  private var pendingUses: [[String]] = []
  private var recentWrite: Task<Void, Never>?
  /// Set by the first successful history read, which may import this device's history.
  private var hasReadHistory = false
  private(set) var isClosed = false
  private let didFail: @MainActor (Error) -> Void

  init(
    client: APIClient, storage: ChatDraftStorage?, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.client = client
    self.storage = storage
    self.didFail = didFail
  }

  func load() async throws -> [ComposerWorkflow] {
    guard !isClosed else { throw CancellationError() }
    do {
      let workflows = try await client.composerWorkflows()
      try Task.checkCancellation()
      guard !isClosed else { throw CancellationError() }
      return workflows
    } catch {
      if !isClosed, !Task.isCancelled { didFail(error) }
      throw error
    }
  }

  /// Opening the slash menu reads its candidates and the member's canonical order together.
  func loadCatalog() async throws -> Catalog {
    async let order = synchronizeRecent()
    let workflows = try await load()
    return Catalog(workflows: workflows, recent: await order)
  }

  func recentIDs() -> [String] {
    do { return try storage?.load("recent-workflows", as: [String].self) ?? recent } catch {
      reportHistoryError(error)
      return recent
    }
  }

  func prepareUse(in text: String, document: ChatDraftDocument?) async throws
    -> [String]
  {
    let text = document.map { visibleText($0.parts) } ?? text
    guard text.contains("/"), !isClosed else { return [] }
    return try await load().filter { workflow in
      let pattern =
        #"(?:^|\s)/"# + NSRegularExpression.escapedPattern(for: workflow.name)
        + #"(?=$|\s)"#
      return text.range(of: pattern, options: .regularExpression) != nil
    }.map(\.id)
  }

  private func visibleText(_ parts: [MessageJSON]) -> String {
    parts.map { part in
      if part["type"]?.string == "text" { return part["text"]?.string ?? "" }
      if part["type"]?.string == "feedback", case .array(let note) = part["note"] {
        return "\n" + visibleText(note) + "\n"
      }
      return "\u{fffc}"
    }.joined()
  }

  /// Accepted delivery is never turned into a send failure by history I/O or synchronization.
  func recordUse(_ ids: [String]) {
    guard !isClosed, !ids.isEmpty else { return }
    var seen = Set<String>()
    saveRecent((ids + recentIDs()).filter { seen.insert($0).inserted })
    recentRevision += 1
    pendingUses.append(ids)
    guard recentWrite == nil else { return }
    recentWrite = Task { [weak self] in await self?.writeRecentUses() }
  }

  func close() {
    isClosed = true
    recentWrite?.cancel()
  }

  /// One write at a time keeps the server's order equal to the acceptance order.
  private func writeRecentUses() async {
    // Device history imports before a use can initialize the member's server history.
    if !hasReadHistory { _ = await synchronizeRecent() }
    while !isClosed, !Task.isCancelled, !pendingUses.isEmpty {
      let ids = pendingUses.removeFirst()
      do {
        let canonical = try await client.recordComposerWorkflowUse(ids)
        // A queued use is newer than this response; its own write caches the next order.
        if !isClosed, pendingUses.isEmpty { saveRecent(canonical) }
      } catch {
        reportSynchronizationError(error)
      }
    }
    recentWrite = nil
  }

  /// The server owns the history; this device's file caches it and orders the menu when a read
  /// fails.
  private func synchronizeRecent() async -> [String] {
    let revision = recentRevision
    // The server may not have applied a use whose write is still running.
    let confirmed = recentWrite == nil
    let local = recentIDs()
    do {
      var ids = try await client.recentComposerWorkflowIDs()
      // Only a never-initialized history imports this device's history; `[]` is initialized.
      if ids == nil, !local.isEmpty { ids = try await client.importComposerWorkflowHistory(local) }
      hasReadHistory = true
      // A use accepted before or during the read is newer than this response.
      guard !isClosed, !Task.isCancelled, confirmed, revision == recentRevision else {
        return recentIDs()
      }
      let canonical = ids ?? []
      saveRecent(canonical)
      return canonical
    } catch {
      reportSynchronizationError(error)
      return recentIDs()
    }
  }

  private func saveRecent(_ ids: [String]) {
    recent = ids
    do { try storage?.save(ids, key: "recent-workflows") } catch { reportHistoryError(error) }
  }

  private func reportSynchronizationError(_ error: Error) {
    guard !isClosed, !Task.isCancelled, !(error is CancellationError) else { return }
    // A required update closes the workspace; other failures keep this device's order.
    didFail(error)
    Logger(subsystem: "ai.okou.ios", category: "Composer")
      .info(
        "event=composer.workflows.recent.sync.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code)"
      )
  }

  private func reportHistoryError(_ error: Error) {
    Logger(subsystem: "ai.okou.ios", category: "Composer")
      .error(
        "event=composer.workflows.recent.failed error_domain=\((error as NSError).domain, privacy: .public) error_code=\((error as NSError).code) error=\(error.localizedDescription, privacy: .private)"
      )
  }
}

enum ComposerWorkflowSearch {
  static func activeRange(in text: String, selection: NSRange) -> NSRange? {
    let value = text as NSString
    guard selection.length == 0, selection.location >= 0, selection.location <= value.length else {
      return nil
    }
    let before = value.substring(to: selection.location)
    guard
      let range = before.range(of: #"(?:^|\s)/[\p{L}\p{M}\p{N}-]*$"#, options: .regularExpression),
      let slash = before[range].lastIndex(of: "/")
    else { return nil }
    return NSRange(slash..<before.endIndex, in: before)
  }

  static func matches(_ workflows: [ComposerWorkflow], query: String, recent: [String])
    -> [ComposerWorkflow]
  {
    let query = query.lowercased()
    let ranks = workflows.compactMap { workflow -> (ComposerWorkflow, Int)? in
      let name = workflow.name.lowercased()
      if let range = name.range(of: query, options: .literal) {
        return (workflow, name == query ? 0 : range.lowerBound == name.startIndex ? 1 : 2)
      }
      if query.isEmpty { return (workflow, 1) }
      if query.utf16.count >= 3, subsequence(query, in: name) { return (workflow, 3) }
      if workflow.description?.lowercased().contains(query) == true { return (workflow, 3) }
      return nil
    }
    let locale = Locale(identifier: "en")
    return ranks.sorted { left, right in
      if left.1 != right.1 { return left.1 < right.1 }
      let l = recent.firstIndex(of: left.0.id) ?? Int.max
      let r = recent.firstIndex(of: right.0.id) ?? Int.max
      if l != r { return l < r }
      let names = left.0.name.compare(right.0.name, options: [], locale: locale)
      if names != .orderedSame { return names == .orderedAscending }
      return left.0.id.compare(right.0.id, options: [], locale: locale) == .orderedAscending
    }.map(\.0)
  }

  private static func subsequence(_ query: String, in name: String) -> Bool {
    // PWA keeps numeric identifiers contiguous while letters may skip ahead.
    let parts = query.ranges(of: /[0-9]+|[^0-9]/).map { String(query[$0]) }
    var remainder = name[...]
    for part in parts {
      guard let range = remainder.range(of: part, options: .literal) else { return false }
      remainder = remainder[range.upperBound...]
    }
    return true
  }
}
