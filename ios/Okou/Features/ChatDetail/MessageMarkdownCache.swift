import ChatDomain
import Foundation
import Textual

/// A workspace owns this disposable presentation cache; durable chat data stays in ChatCache.
@MainActor
final class MessageMarkdownCache {
  private(set) var diagrams = MessageMermaidRenderer()
  private(set) var codeHighlights = StructuredText.CodeHighlightCache()
  let unitMeasurements = MessageUnitMeasurements()
  private struct Entry {
    let content: AttributedString
    let cost: Int
    var lastUse: UInt64
    var tables: (viewport: MessageTableLayout.Viewport, layouts: MessageTableLayouts)?
    var plan: (context: MessageRenderPlan.Context, value: MessageRenderPlan)?
  }

  private struct TableKey: Hashable {
    let text: String
    let viewport: MessageTableLayout.Viewport
  }

  private struct PlanKey: Hashable {
    let text: String
    let context: MessageRenderPlan.Context
  }

  private var worker: MarkdownWorker
  private let baseURL: URL
  private let costLimit: Int
  private let entryLimit: Int
  private var entries: [String: Entry] = [:]
  private var inFlight: [String: Task<AttributedString, Never>] = [:]
  private var tableTasks: [TableKey: Task<MessageTableLayouts, Never>] = [:]
  private var planTasks: [PlanKey: Task<MessageRenderPlan, Never>] = [:]
  private var totalCost = 0
  private var clock: UInt64 = 0
  private var generation = UUID()

  init(baseURL: URL, costLimit: Int = 8 * 1024 * 1024, entryLimit: Int = 256) {
    self.baseURL = baseURL
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

  func prepareTables(
    for text: String, viewport: MessageTableLayout.Viewport
  ) async -> MessageTableLayouts {
    guard text.contains("|"), !Task.isCancelled else { return [:] }
    let content = await content(for: text)
    guard !Task.isCancelled else { return [:] }
    if let tables = entries[text]?.tables, tables.viewport == viewport { return tables.layouts }
    let key = TableKey(text: text, viewport: viewport)
    let currentGeneration = generation
    if let task = tableTasks[key] {
      let layouts = await task.value
      return currentGeneration == generation && !Task.isCancelled ? layouts : [:]
    }
    let task = Task { [worker] in await worker.prepareTables(content, viewport: viewport) }
    tableTasks[key] = task
    let layouts = await task.value
    guard currentGeneration == generation else { return [:] }
    tableTasks[key] = nil
    entries[text]?.tables = (viewport, layouts)
    return layouts
  }

  func cachedPlan(for text: String, context: MessageRenderPlan.Context) -> MessageRenderPlan? {
    guard let plan = entries[text]?.plan, plan.context == context else { return nil }
    _ = cached(text)
    return plan.value
  }

  func renderPlan(for text: String, context: MessageRenderPlan.Context) async -> MessageRenderPlan?
  {
    guard !Task.isCancelled else { return nil }
    if let plan = cachedPlan(for: text, context: context) { return plan }
    let currentGeneration = generation
    let content = await content(for: text)
    guard generation == currentGeneration, !Task.isCancelled else { return nil }
    if let plan = cachedPlan(for: text, context: context) { return plan }
    let key = PlanKey(text: text, context: context)
    if let task = planTasks[key] {
      let plan = await task.value
      return generation == currentGeneration && !Task.isCancelled ? plan : nil
    }
    let task = Task { [worker] in await worker.renderPlan(content, source: text, context: context) }
    planTasks[key] = task
    let plan = await task.value
    guard generation == currentGeneration else { return nil }
    planTasks[key] = nil
    entries[text]?.plan = (context, plan)
    return Task.isCancelled ? nil : plan
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
    diagrams = MessageMermaidRenderer()
    codeHighlights = StructuredText.CodeHighlightCache()
    unitMeasurements.clear()
    worker = MarkdownWorker(baseURL: baseURL)
    generation = UUID()
    for task in inFlight.values { task.cancel() }
    inFlight.removeAll()
    for task in tableTasks.values { task.cancel() }
    tableTasks.removeAll()
    for task in planTasks.values { task.cancel() }
    planTasks.removeAll()
    entries.removeAll()
    totalCost = 0
  }
}

private actor MarkdownWorker {
  let baseURL: URL
  private var tableLayouts = MessageTableLayout.Cache()

  init(baseURL: URL) { self.baseURL = baseURL }

  func prepareTables(
    _ content: AttributedString, viewport: MessageTableLayout.Viewport
  ) -> MessageTableLayouts {
    tableLayouts.prepare(content, viewport: viewport)
  }

  func renderPlan(
    _ content: AttributedString, source: String, context: MessageRenderPlan.Context
  ) -> MessageRenderPlan {
    MessageRenderPlan(content: content, source: source, context: context)
  }

  func parse(_ text: String) -> AttributedString {
    guard !Task.isCancelled else { return AttributedString(text) }
    // Foundation drops imageURL for an image inside a link. Source positions let us recover
    // that image node without scanning code/HTML or changing the authored outer destination.
    let tracksImages = text.contains("![")
    let tracksDiagrams = text.contains("mermaid")
    guard
      var content = try? AttributedString(
        markdown: text, including: \.textual,
        options: .init(appliesSourcePositionAttributes: tracksImages || tracksDiagrams),
        baseURL: baseURL)
    else {
      return AttributedString(text)
    }
    if tracksImages {
      for run in content.runs {
        guard run.link != nil, run.imageURL == nil,
          run.inlinePresentationIntent?.contains(.code) != true,
          let position = run.markdownSourcePosition, let range = Range(position, in: text),
          text[range].hasPrefix("!["),
          let image = try? AttributedString(
            markdown: String(text[range]), including: \.textual, baseURL: baseURL),
          let url = image.runs.first?.imageURL
        else { continue }
        content[run.range].imageURL = url
      }
    }
    if !tracksDiagrams { content.markdownSourcePosition = nil }
    return content
  }
}
