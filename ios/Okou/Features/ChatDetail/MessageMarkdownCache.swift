import ChatDomain
import Foundation
import Textual

/// A workspace owns this disposable presentation cache; durable chat data stays in ChatCache.
@MainActor
final class MessageMarkdownCache {
  private struct Entry {
    let content: AttributedString
    let cost: Int
    var lastUse: UInt64
  }

  private let worker: MarkdownWorker
  private let costLimit: Int
  private let entryLimit: Int
  private var entries: [String: Entry] = [:]
  private var inFlight: [String: Task<AttributedString, Never>] = [:]
  private var totalCost = 0
  private var clock: UInt64 = 0
  private var generation = UUID()

  init(baseURL: URL, costLimit: Int = 8 * 1024 * 1024, entryLimit: Int = 256) {
    worker = MarkdownWorker(baseURL: baseURL)
    self.costLimit = costLimit
    self.entryLimit = entryLimit
  }

  func cached(_ text: String) -> AttributedString? {
    guard var entry = entries[text] else { return nil }
    clock &+= 1
    entry.lastUse = clock
    entries[text] = entry
    return entry.content
  }

  func content(for text: String) async -> AttributedString {
    guard !Task.isCancelled else { return AttributedString(text) }
    if let content = cached(text) { return content }
    if let task = inFlight[text] { return await task.value }
    let currentGeneration = generation
    let task = Task { [worker] in await worker.parse(text) }
    inFlight[text] = task
    let content = await task.value
    guard generation == currentGeneration else { return content }
    inFlight[text] = nil

    // This bounds retained source and attributed runs, rather than the number of conversations.
    let cost = text.utf8.count * 8 + content.runs.count * 192
    guard cost <= costLimit, entryLimit > 0 else { return content }
    while !entries.isEmpty && (totalCost + cost > costLimit || entries.count >= entryLimit) {
      guard let oldest = entries.min(by: { $0.value.lastUse < $1.value.lastUse }) else { break }
      totalCost -= oldest.value.cost
      entries[oldest.key] = nil
    }
    clock &+= 1
    entries[text] = Entry(content: content, cost: cost, lastUse: clock)
    totalCost += cost
    return content
  }

  func prepareLatest(_ messages: [ChatMessage]) async {
    // Prepare the landing viewport before publication; older rows are prepared on demand.
    let currentGeneration = generation
    for message in messages.suffix(4).reversed() {
      guard !Task.isCancelled, generation == currentGeneration else { return }
      _ = await content(for: message.text)
    }
  }

  func clear() {
    generation = UUID()
    for task in inFlight.values { task.cancel() }
    inFlight.removeAll()
    entries.removeAll()
    totalCost = 0
  }
}

private actor MarkdownWorker {
  let baseURL: URL

  init(baseURL: URL) { self.baseURL = baseURL }

  func parse(_ text: String) -> AttributedString {
    guard !Task.isCancelled else { return AttributedString(text) }
    // Match Textual's pinned parser (no syntax extensions), outside the main actor.
    return (try? AttributedString(markdown: text, including: \.textual, baseURL: baseURL))
      ?? AttributedString(text)
  }
}

struct PreparedMessageParser: MarkupParser {
  let content: AttributedString

  func attributedString(for input: String) throws -> AttributedString { content }
}
