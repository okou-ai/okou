import CCState
import ChatDomain
import Foundation

/// Confirmed conversation inputs and their projections share one resident owner.
/// Delivery, persistence and native window actions remain in ConversationStore.
/// Its values live in the workspace session's Store: ChatDetailView reads `value` through
/// CCStateSwiftUI, and owner logic uses the synchronous accessors. Nothing republishes the graph
/// through Observation.
@MainActor
final class ConversationProjection {
  private struct Input {
    var history: ChatHistory?
    var interruptEvents: [String: String] = [:]

    var presentedHistory: ChatHistory? { history?.interrupting(Set(interruptEvents.keys)) }
    var pending: [ConversationStore.PendingMessage] = []
    var expanded: Set<String> = []
    var closed = false
  }

  /// What the transcript renders from this conversation, derived in one graph read.
  struct Value: Equatable {
    let history: ChatHistory?
    let pending: [ConversationStore.PendingMessage]
    let items: [ConversationItem]
    let streamed: [ConversationStore.StreamedOutput]

    /// Recommendations stay hidden while the member's own messages are pending.
    var recommendedFollowups: ChatRecommendedFollowupSource? {
      pending.isEmpty ? history?.recommendedFollowups : nil
    }
  }

  /// The workspace session's Store, which keeps this projection's values.
  let store: CCState.Store
  private let input = CCState.State(Input())
  private let streamedInput = CCState.State<[ConversationStore.StreamedOutput]>([])
  private let replaceStream: Command<Void, [ConversationStore.StreamedOutput]>
  private let messagesValue: Computed<[ChatMessage]>
  private let itemsValue: Computed<[ConversationItem]>
  private let streamedValue: Computed<[ConversationStore.StreamedOutput]>
  /// Everything the transcript reads, for CCStateSwiftUI.
  let value: Computed<Value>
  let pendingMessages: Computed<[ConversationStore.PendingMessage]>
  private let write: Command<Void, (inout Input) -> Void>

  init(store: CCState.Store) {
    self.store = store
    let input = input
    pendingMessages = Computed { get in try get(input).pending }
    let streamedInput = streamedInput
    let messages = Computed<[ChatMessage]> { get in
      let value = try get(input)
      let persisted = value.history?.persistedEventIDs ?? []
      return (value.history?.messages ?? [])
        + value.pending.filter { !persisted.contains($0.id) }.map(\.message)
    }
    messagesValue = messages
    let items = Computed<[ConversationItem]> { get in
      let value = try get(input)
      return Self.items(
        messages: try get(messages), history: value.presentedHistory, expanded: value.expanded)
    }
    itemsValue = items
    let streamed = Computed<[ConversationStore.StreamedOutput]> { get in
      let value = try get(input)
      let persisted = value.history?.persistedEventIDs ?? []
      let messageIDs = Set((value.history?.messages ?? []).map { $0.id.lowercased() })
      return try get(streamedInput).filter {
        !$0.text.isEmpty && !persisted.contains($0.eventID)
          && !messageIDs.contains($0.eventID)
      }
    }
    streamedValue = streamed
    value = Computed { get in
      let current = try get(input)
      return Value(
        history: current.presentedHistory, pending: current.pending, items: try get(items),
        streamed: try get(streamed))
    }
    replaceStream = Command { context, value in try context.set(streamedInput, value) }
    write = Command { context, update in
      try context.set(
        input,
        update: { previous in
          var next = previous
          update(&next)
          return next
        })
    }
  }

  private var snapshot: Input { read(input) }

  /// The synchronous value of `value`, for a render whose graph read has not resolved.
  var currentValue: Value { read(value) }
  var history: ChatHistory? { snapshot.history }
  var pending: [ConversationStore.PendingMessage] { snapshot.pending }
  var messages: [ChatMessage] { read(messagesValue) }
  var items: [ConversationItem] { read(itemsValue) }
  var streamed: [ConversationStore.StreamedOutput] { read(streamedValue) }

  func confirmHistory(_ history: ChatHistory?) {
    guard history != snapshot.history else { return }
    update {
      $0.history = history
      let persisted = Set((history?.persistedEventIDs ?? []).map { $0.lowercased() })
      $0.interruptEvents = $0.interruptEvents.filter { !persisted.contains($0.value) }
      $0.expanded.formIntersection((history?.workSections ?? []).map(\.id))
    }
  }

  func interruptRuns(_ events: [String: String]) {
    update { $0.interruptEvents.merge(events) { _, newest in newest } }
  }

  func replacePending(_ pending: [ConversationStore.PendingMessage]) {
    update { $0.pending = pending }
  }

  func publishStream(_ streamed: [ConversationStore.StreamedOutput]) {
    guard !snapshot.closed, streamed != read(streamedInput) else { return }
    do { try store.set(replaceStream, streamed) } catch {
      preconditionFailure("Cannot publish local streamed input: \(error)")
    }
  }

  func toggleWorkHistory(_ sectionID: String) {
    guard let section = history?.workSections.first(where: { $0.id == sectionID }),
      section.isCollapsible
    else { return }
    update {
      if !$0.expanded.insert(sectionID).inserted { $0.expanded.remove(sectionID) }
    }
  }

  func close() {
    update { $0.closed = true }
  }

  private func update(_ mutation: @escaping (inout Input) -> Void) {
    guard !snapshot.closed else { return }
    do { try store.set(write, mutation) } catch {
      preconditionFailure("Cannot update the local conversation projection: \(error)")
    }
  }

  private func read<T>(_ signal: Signal<T>) -> T {
    // Only synchronous local values and non-failing derivations live in this graph.
    // HTTP, replay, persistence and delivery errors retain their existing owners.
    do { return try store.get(signal) } catch {
      preconditionFailure("Cannot read the local conversation projection: \(error)")
    }
  }

  private static func items(
    messages: [ChatMessage], history: ChatHistory?, expanded: Set<String>
  ) -> [ConversationItem] {
    let sections = history?.workSections ?? []
    let headers = Dictionary(
      uniqueKeysWithValues: sections.map { ($0.hiddenMessageIDs.first ?? $0.anchorMessageID, $0) })
    let hiddenSections = Dictionary(
      uniqueKeysWithValues: sections.flatMap { section in
        section.hiddenMessageIDs.map { ($0, section) }
      })
    var items: [ConversationItem] = []
    let usageAnchors = history?.runUsageAnchors ?? [:]
    for message in messages {
      if let section = headers[message.id] {
        items.append(.work(section, expanded: expanded.contains(section.id)))
      }
      if let section = hiddenSections[message.id] {
        if section.isCollapsible && !expanded.contains(section.id) { continue }
        items.append(.message(message, isWorkHistory: true))
      } else {
        items.append(.message(message))
      }
      if let runID = message.runID, usageAnchors[runID] == message.id,
        history?.usageEventIDs[runID] != nil
      {
        items.append(.usage(runID: runID))
      }
    }
    return items
  }
}
