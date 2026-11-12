import CCState
import ChatDomain
import Foundation
import Observation

/// Confirmed conversation inputs and their projections share one resident owner.
/// Delivery, persistence and native window actions remain in ConversationStore.
@MainActor @Observable
final class ConversationProjection {
  private struct Input {
    var history: ChatHistory?
    var pending: [ConversationStore.PendingMessage] = []
    var expanded: Set<String> = []
    var closed = false
  }

  @ObservationIgnored private let store = CCState.Store()
  @ObservationIgnored private let input = CCState.State(Input())
  @ObservationIgnored private let streamedInput = CCState.State<[ConversationStore.StreamedOutput]>(
    [])
  @ObservationIgnored private let replaceStream: Command<Void, [ConversationStore.StreamedOutput]>
  @ObservationIgnored private let messagesValue: Computed<[ChatMessage]>
  @ObservationIgnored private let itemsValue: Computed<[ConversationItem]>
  @ObservationIgnored private let streamedValue: Computed<[ConversationStore.StreamedOutput]>
  @ObservationIgnored private let write: Command<Void, (inout Input) -> Void>
  @ObservationIgnored private var subscription: Subscription?
  @ObservationIgnored private var streamSubscription: Subscription?

  init() {
    let input = input
    let streamedInput = streamedInput
    let messages = Computed<[ChatMessage]> { get in
      let value = try get(input)
      let persisted = value.history?.persistedEventIDs ?? []
      return (value.history?.messages ?? [])
        + value.pending.filter { !persisted.contains($0.id) }.map(\.message)
    }
    messagesValue = messages
    itemsValue = Computed { get in
      let value = try get(input)
      return Self.items(
        messages: try get(messages), history: value.history, expanded: value.expanded)
    }
    streamedValue = Computed { get in
      let value = try get(input)
      let persisted = value.history?.persistedEventIDs ?? []
      let messageIDs = Set((value.history?.messages ?? []).map { $0.id.lowercased() })
      return try get(streamedInput).filter {
        !$0.text.isEmpty && !persisted.contains($0.eventID)
          && !messageIDs.contains($0.eventID)
      }
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
    do {
      subscription = try store.watch(input) { [weak self] in
        guard let self else { return }
        // Invalidate native Observation consumers without copying a projection.
        withMutation(keyPath: \.snapshot) {}
      }
      streamSubscription = try store.watch(streamedValue) { [weak self] in
        guard let self else { return }
        withMutation(keyPath: \.streamed) {}
      }
    } catch { preconditionFailure("Cannot observe the local conversation projection: \(error)") }
  }

  private var snapshot: Input {
    access(keyPath: \.snapshot)
    return read(input)
  }

  var history: ChatHistory? { snapshot.history }
  var pending: [ConversationStore.PendingMessage] { snapshot.pending }
  var messages: [ChatMessage] {
    access(keyPath: \.snapshot)
    return read(messagesValue)
  }
  var items: [ConversationItem] {
    access(keyPath: \.snapshot)
    return read(itemsValue)
  }
  var streamed: [ConversationStore.StreamedOutput] {
    access(keyPath: \.streamed)
    return read(streamedValue)
  }

  func confirmHistory(_ history: ChatHistory?) {
    guard history != snapshot.history else { return }
    update {
      $0.history = history
      $0.expanded.formIntersection((history?.workSections ?? []).map(\.id))
    }
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
    do { try subscription?.cancel() } catch {
      preconditionFailure("Cannot release the local conversation projection: \(error)")
    }
    subscription = nil
    do { try streamSubscription?.cancel() } catch {
      preconditionFailure("Cannot release the local stream projection: \(error)")
    }
    streamSubscription = nil
  }

  private func update(_ mutation: @escaping (inout Input) -> Void) {
    guard !snapshot.closed else { return }
    do { try store.set(write, mutation) } catch {
      preconditionFailure("Cannot update the local conversation projection: \(error)")
    }
  }

  private func read<Value>(_ signal: Signal<Value>) -> Value {
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
