import CCState
import ChatDomain
import Foundation
import Observation

/// A graph belongs to one Agent/thread draft, never to the currently visible editor.
@MainActor @Observable
final class ComposerDraftSignals {
  struct Content {
    var document = ChatDraftDocument()
    var quoteIDs: [UUID] = []
    var textIDs: [UUID] = [UUID()]
    var focusRequest: ComposerDraftStore.EditorFocusRequest?
    var generation = UUID()
    var closed = false
  }

  @ObservationIgnored private let store = CCState.Store()
  @ObservationIgnored private let content = CCState.State(Content())
  @ObservationIgnored private let blocks: Computed<[ComposerDraftStore.EditorBlock]>
  @ObservationIgnored private let write: Command<Void, (inout Content) -> Void>
  @ObservationIgnored private var subscription: Subscription?

  init() {
    let content = content
    blocks = Computed { get in Self.editorBlocks(try get(content)) }
    write = Command { context, update in
      try context.set(
        content,
        update: { previous in
          var next = previous
          update(&next)
          return next
        })
    }
    do {
      subscription = try store.watch(content) { [weak self] in
        guard let self else { return }
        // Bridge CCState invalidation into existing native Observation consumers.
        // There is no second copy of the document or publication revision.
        withMutation(keyPath: \.snapshot) {}
      }
    } catch { preconditionFailure("Cannot observe the draft graph: \(error)") }
  }

  var snapshot: Content {
    access(keyPath: \.snapshot)
    return read(content)
  }

  var editorBlocks: [ComposerDraftStore.EditorBlock] {
    access(keyPath: \.snapshot)
    return read(blocks)
  }

  func replaceDocument(_ document: ChatDraftDocument) {
    update { $0.document = document }
  }

  func resetEditors() {
    update {
      $0.quoteIDs = $0.document.parts.filter { $0["type"]?.string == "feedback" }.map { _ in UUID()
      }
      $0.textIDs = (0...$0.quoteIDs.count).map { _ in UUID() }
      $0.focusRequest = nil
      $0.generation = UUID()
    }
  }

  func requestFocus(_ id: UUID) {
    guard editorBlocks.contains(where: { $0.id == id }) else { return }
    update { $0.focusRequest = ComposerDraftStore.EditorFocusRequest(blockID: id) }
  }

  func consumeFocus(_ request: ComposerDraftStore.EditorFocusRequest) {
    update { if $0.focusRequest == request { $0.focusRequest = nil } }
  }

  func addFeedback(_ selection: ChatFeedbackSelection) -> UUID? {
    guard !snapshot.closed, snapshot.document.isSupported else { return nil }
    let id = UUID()
    update {
      $0.document.parts.append(selection.part)
      $0.quoteIDs.append(id)
      $0.textIDs.append(UUID())
      $0.focusRequest = ComposerDraftStore.EditorFocusRequest(blockID: id)
    }
    return id
  }

  @discardableResult
  func editBlock(_ id: UUID, document: ChatDraftDocument) -> Bool {
    guard !snapshot.closed, document.isSupported,
      let block = editorBlocks.first(where: { $0.id == id }), document != block.content
    else { return false }
    update {
      if block.isFeedback, case .object(var part) = $0.document.parts[block.indices.lowerBound] {
        part["note"] = .array(document.parts)
        $0.document.parts[block.indices.lowerBound] = .object(part)
      } else {
        $0.document.parts.replaceSubrange(block.indices, with: document.parts)
      }
    }
    return true
  }

  @discardableResult
  func removeFeedback(_ id: UUID, focusedID: UUID?) -> Bool {
    guard !snapshot.closed, let ordinal = snapshot.quoteIDs.firstIndex(of: id),
      let block = editorBlocks.first(where: { $0.id == id })
    else { return false }
    let blocks = editorBlocks
    let separatesParagraphs =
      blocks[ordinal * 2].hasParagraph && blocks[ordinal * 2 + 2].hasParagraph
    update {
      $0.document.parts.replaceSubrange(
        block.indices,
        with: separatesParagraphs
          ? [.object(["type": .string("text"), "text": .string("\n")])] : [])
      // Keep the native first responder when adjacent text gaps merge.
      if let focusedID, [$0.textIDs[ordinal], id, $0.textIDs[ordinal + 1]].contains(focusedID) {
        $0.textIDs[ordinal] = focusedID
      }
      $0.quoteIDs.remove(at: ordinal)
      $0.textIDs.remove(at: ordinal + 1)
      $0.focusRequest = focusedID.map { ComposerDraftStore.EditorFocusRequest(blockID: $0) }
    }
    return true
  }

  func isCurrent(generation: UUID, blockID: UUID) -> Bool {
    let value = snapshot
    return !value.closed && value.generation == generation
      && editorBlocks.contains(where: { $0.id == blockID })
  }

  func close() {
    update { $0.closed = true }
    do { try subscription?.cancel() } catch {
      preconditionFailure("Cannot release the draft graph: \(error)")
    }
    subscription = nil
  }

  private func update(_ mutation: @escaping (inout Content) -> Void) {
    guard !snapshot.closed else { return }
    do { try store.set(write, mutation) } catch {
      preconditionFailure("Cannot update the in-process draft graph: \(error)")
    }
  }

  private func read<Value>(_ signal: Signal<Value>) -> Value {
    // This private graph contains only synchronous, non-failing local derivations.
    // HTTP, disk and upload failures retain their existing recoverable owners.
    do { return try store.get(signal) } catch {
      preconditionFailure("Cannot read the in-process draft graph: \(error)")
    }
  }

  private static func editorBlocks(_ value: Content) -> [ComposerDraftStore.EditorBlock] {
    let document = value.document
    guard document.isSupported else { return [] }
    var blocks: [ComposerDraftStore.EditorBlock] = []
    var start = 0
    var ordinal = 0
    for (index, part) in document.parts.enumerated() where part["type"]?.string == "feedback" {
      blocks.append(
        ComposerDraftStore.EditorBlock(
          id: value.textIDs[ordinal], indices: start..<index, quote: nil,
          content: ChatDraftDocument(parts: Array(document.parts[start..<index]))))
      guard let quote = part["quote"]?.string, case .array(let note) = part["note"] else {
        return []
      }
      blocks.append(
        ComposerDraftStore.EditorBlock(
          id: value.quoteIDs[ordinal], indices: index..<(index + 1), quote: quote,
          content: ChatDraftDocument(parts: note)))
      ordinal += 1
      start = index + 1
    }
    blocks.append(
      ComposerDraftStore.EditorBlock(
        id: value.textIDs[ordinal], indices: start..<document.parts.count, quote: nil,
        content: ChatDraftDocument(parts: Array(document.parts[start...]))))
    return blocks
  }
}
