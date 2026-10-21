import ChatData
import ChatDomain
import Foundation
import OSLog

/// This object belongs to one immutable account/workspace scope.
@MainActor
final class ComposerWorkflowSource {
  let id = UUID()
  private let client: APIClient
  private let storage: ChatDraftStorage?
  private var recent: [String] = []
  private(set) var isClosed = false
  private let didFail: @MainActor (Error) -> Void

  init(client: APIClient, storage: ChatDraftStorage?, didFail: @escaping @MainActor (Error) -> Void)
  {
    self.client = client
    self.storage = storage
    self.didFail = didFail
  }

  func load(agentID: String) async throws -> [ComposerWorkflow] {
    guard !isClosed else { throw CancellationError() }
    do {
      let workflows = try await client.composerWorkflows(agentID: agentID)
      try Task.checkCancellation()
      guard !isClosed else { throw CancellationError() }
      return workflows
    } catch {
      if !isClosed, !Task.isCancelled { didFail(error) }
      throw error
    }
  }

  func recentIDs() -> [String] {
    do { return try storage?.load("recent-workflows", as: [String].self) ?? recent } catch {
      reportHistoryError(error)
      return recent
    }
  }

  func prepareUse(in text: String, document: ChatDraftDocument?, agentID: String) async throws
    -> [String]
  {
    let text = document.map { visibleText($0.parts) } ?? text
    guard text.contains("/"), !isClosed else { return [] }
    return try await load(agentID: agentID).filter { workflow in
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

  /// Accepted delivery is never turned into a send failure by local history I/O.
  func recordUse(_ ids: [String]) {
    guard !isClosed, !ids.isEmpty else { return }
    var seen = Set<String>()
    recent = (ids + recentIDs()).filter { seen.insert($0).inserted }
    do { try storage?.save(recent, key: "recent-workflows") } catch { reportHistoryError(error) }
  }

  func close() { isClosed = true }

  private func reportHistoryError(_ error: Error) {
    Logger(subsystem: "ai.okou.ios", category: "Composer")
      .error("Cannot persist recent Workflows: \(error.localizedDescription, privacy: .public)")
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
