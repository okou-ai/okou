import CCState
import ChatDomain
import Foundation

/// One composer draft's graph, never the currently visible editor's. Its values live in the
/// workspace session's Store. SwiftUI reads `presentation` and `unsentContent` through
/// CCStateSwiftUI, and actions use the synchronous accessors. Nothing republishes the graph
/// through Observation.
@MainActor
final class ComposerDraftSignals {
  struct Content: Equatable {
    var document = ChatDraftDocument()
    var quoteIDs: [UUID] = []
    var textIDs: [UUID] = [UUID()]
    var focusRequest: ComposerDraftStore.EditorFocusRequest?
    var generation = UUID()
    var closed = false
  }

  /// The answer for a reader without a composer, such as a chat that is not held in memory.
  static let noContent = Computed { _ in false }

  private let store: CCState.Store
  private let content: CCState.State<Content>
  private let status: CCState.State<ComposerDraftStatus>
  /// The draft's document and editor identity.
  let value: Computed<Content>
  let blocks: Computed<[ComposerEditorBlock]>
  /// Everything the composer UI reads, derived together with the uploads and voice input.
  let presentation: Computed<ComposerDraftPresentation>
  /// Whether text or files are unsent, for readers outside the composer such as the sidebar.
  let unsentContent: Computed<Bool>
  private let write: Command<Void, (inout Content) -> Void>

  init(
    store: CCState.Store, uploads: Computed<AttachmentDraftStore.Content>,
    voice: Computed<ComposerVoiceInputStore.Content>?
  ) {
    self.store = store
    let content = CCState.State(Content())
    self.content = content
    let status = CCState.State(ComposerDraftStatus())
    self.status = status
    value = Computed { get in try get(content) }
    let blocks = Computed { get in Self.editorBlocks(try get(content)) }
    self.blocks = blocks
    unsentContent = Computed { get in
      ComposerDraftRules.hasContent(try get(content), try get(uploads))
    }
    presentation = Computed { get in
      let draft = try get(content)
      let state = try get(status)
      let files = try get(uploads)
      var recording: ComposerVoiceInputStore.Content?
      if let voice { recording = try get(voice) }
      return ComposerDraftPresentation(
        draft: draft, editorBlocks: try get(blocks), status: state, attachments: files,
        voicePhase: recording?.phase, voiceHasError: recording?.error != nil,
        hasContent: ComposerDraftRules.hasContent(draft, files),
        canSend: ComposerDraftRules.canSend(draft, state, files, recording),
        canEditVoice: ComposerDraftRules.canEditDocument(draft, state))
    }
    write = Command { context, update in
      try context.set(
        content,
        update: { previous in
          var next = previous
          update(&next)
          return next
        })
    }
  }

  var snapshot: Content { read(content) }

  var statusSnapshot: ComposerDraftStatus { read(status) }

  /// The synchronous value of `presentation`, for a render whose graph read has not resolved.
  var currentPresentation: ComposerDraftPresentation { read(presentation) }

  var editorBlocks: [ComposerEditorBlock] { read(blocks) }

  func updateStatus(_ mutation: (inout ComposerDraftStatus) -> Void) {
    do {
      try store.set(
        status,
        update: { previous in
          var next = previous
          mutation(&next)
          return next
        })
    } catch { preconditionFailure("Cannot update the draft status graph: \(error)") }
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
  func removeFeedback(_ id: UUID, focusedID: UUID?, keepingNote: Bool = false) -> Bool {
    guard !snapshot.closed, let ordinal = snapshot.quoteIDs.firstIndex(of: id),
      let block = editorBlocks.first(where: { $0.id == id })
    else { return false }
    let blocks = editorBlocks
    let separatesParagraphs =
      blocks[ordinal * 2].hasParagraph && blocks[ordinal * 2 + 2].hasParagraph
    let newline = MessageJSON.object(["type": .string("text"), "text": .string("\n")])
    let note = keepingNote ? block.content.parts : []
    let replacement: [MessageJSON]
    if note.isEmpty {
      replacement = separatesParagraphs ? [newline] : []
    } else {
      replacement =
        (blocks[ordinal * 2].hasParagraph ? [newline] : []) + note
        + (blocks[ordinal * 2 + 2].hasParagraph ? [newline] : [])
    }
    update {
      $0.document.parts.replaceSubrange(
        block.indices, with: replacement)
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

  private static func editorBlocks(_ value: Content) -> [ComposerEditorBlock] {
    let document = value.document
    guard document.isSupported else { return [] }
    var blocks: [ComposerEditorBlock] = []
    var start = 0
    var ordinal = 0
    for (index, part) in document.parts.enumerated() where part["type"]?.string == "feedback" {
      blocks.append(
        ComposerEditorBlock(
          id: value.textIDs[ordinal], indices: start..<index, quote: nil,
          content: ChatDraftDocument(parts: Array(document.parts[start..<index]))))
      guard let quote = part["quote"]?.string, case .array(let note) = part["note"] else {
        return []
      }
      blocks.append(
        ComposerEditorBlock(
          id: value.quoteIDs[ordinal], indices: index..<(index + 1), quote: quote,
          content: ChatDraftDocument(parts: note)))
      ordinal += 1
      start = index + 1
    }
    blocks.append(
      ComposerEditorBlock(
        id: value.textIDs[ordinal], indices: start..<document.parts.count, quote: nil,
        content: ChatDraftDocument(parts: Array(document.parts[start...]))))
    return blocks
  }
}
