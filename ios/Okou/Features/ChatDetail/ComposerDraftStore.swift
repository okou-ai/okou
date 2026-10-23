import ChatData
import ChatDomain
import Foundation
import Observation

/// One composer owns device persistence, canonical draft hydration and a serialized save loop.
@MainActor @Observable
final class ComposerDraftStore {
  struct LocalRecord: Codable {
    var value: ComposerDraft
    var files: [AttachmentDraftStore.SavedItem]
    var baseline: ComposerDraft?
    var dirty: Bool
    var cleared: Bool
  }

  var text: String {
    get { document.text }
    set {
      guard !closed, newValue != document.text else { return }
      document.replaceText(newValue)
      changed()
    }
  }
  struct EditorBlock: Identifiable {
    let id: UUID
    let indices: Range<Int>
    let quote: String?
    let content: ChatDraftDocument
    var isFeedback: Bool { quote != nil }
    var hasParagraph: Bool {
      content.parts.contains {
        ["text", "chat_thread", "agent", "template"].contains($0["type"]?.string ?? "")
      }
    }
    var searchableRanges: [NSRange] {
      var result: [NSRange] = []
      var offset = 0
      var continuesText = false
      for part in content.parts {
        guard part["type"]?.string == "text", let text = part["text"]?.string else {
          continuesText = false
          if ComposerAttributedDocument.isInline(part) { offset += 1 }
          continue
        }
        let length = text.utf16.count
        if continuesText {
          result[result.count - 1].length += length
        } else {
          result.append(NSRange(location: offset, length: length))
        }
        offset += length
        continuesText = true
      }
      return result
    }
  }

  struct EditorFocusRequest: Equatable {
    let id = UUID()
    let blockID: UUID
  }

  private var quoteIDs: [UUID] = []
  private var textIDs: [UUID] = [UUID()]
  private(set) var focusRequest: EditorFocusRequest?
  private(set) var editorGeneration = UUID()
  var editorBlocks: [EditorBlock] {
    guard document.isSupported else { return [] }
    var blocks: [EditorBlock] = []
    var start = 0
    var ordinal = 0
    for (index, part) in document.parts.enumerated() where part["type"]?.string == "feedback" {
      blocks.append(
        EditorBlock(
          id: textIDs[ordinal], indices: start..<index, quote: nil,
          content: ChatDraftDocument(parts: Array(document.parts[start..<index]))))
      guard let quote = part["quote"]?.string, case .array(let note) = part["note"] else {
        return []
      }
      blocks.append(
        EditorBlock(
          id: quoteIDs[ordinal], indices: index..<(index + 1), quote: quote,
          content: ChatDraftDocument(parts: note)))
      ordinal += 1
      start = index + 1
    }
    blocks.append(
      EditorBlock(
        id: textIDs[ordinal], indices: start..<document.parts.count, quote: nil,
        content: ChatDraftDocument(parts: Array(document.parts[start...]))))
    return blocks
  }

  private func resetEditors() {
    editor.dismissMentions()
    editor.workflows.dismiss()
    quoteIDs = document.parts.filter { $0["type"]?.string == "feedback" }.map { _ in UUID() }
    textIDs = (0...quoteIDs.count).map { _ in UUID() }
    focusRequest = nil
    editorGeneration = UUID()
  }

  func requestEditorFocus(_ id: UUID) {
    guard !closed, editorBlocks.contains(where: { $0.id == id }) else { return }
    focusRequest = EditorFocusRequest(blockID: id)
  }

  func consumeFocusRequest(_ request: EditorFocusRequest) {
    if focusRequest == request { focusRequest = nil }
  }

  @discardableResult func addFeedback(_ selection: ChatFeedbackSelection) -> UUID? {
    guard !closed, document.isSupported else { return nil }
    document.parts.append(selection.part)
    let id = UUID()
    quoteIDs.append(id)
    textIDs.append(UUID())
    focusRequest = EditorFocusRequest(blockID: id)
    changed()
    return id
  }

  func editBlock(_ id: UUID, text: String) {
    guard !closed, let block = editorBlocks.first(where: { $0.id == id }),
      block.content.text != text
    else { return }
    var content = block.content
    content.replaceText(text)
    editBlock(id, document: content)
  }

  func editBlock(_ id: UUID, document content: ChatDraftDocument) {
    guard !closed, let block = editorBlocks.first(where: { $0.id == id }),
      content != block.content, content.isSupported
    else { return }
    if block.isFeedback, case .object(var part) = document.parts[block.indices.lowerBound] {
      part["note"] = .array(content.parts)
      document.parts[block.indices.lowerBound] = .object(part)
    } else {
      document.parts.replaceSubrange(block.indices, with: content.parts)
    }
    changed()
  }

  func removeFeedback(_ id: UUID) {
    guard !closed, let ordinal = quoteIDs.firstIndex(of: id),
      let block = editorBlocks.first(where: { $0.id == id })
    else { return }
    let blocks = editorBlocks
    // Removing a block between text sections leaves two paragraphs, as on the web.
    let separatesParagraphs =
      blocks[ordinal * 2].hasParagraph && blocks[ordinal * 2 + 2].hasParagraph
    document.parts.replaceSubrange(
      block.indices,
      with: separatesParagraphs
        ? [.object(["type": .string("text"), "text": .string("\n")])] : [])
    quoteIDs.remove(at: ordinal)
    textIDs.remove(at: ordinal + 1)
    // The removed note hands focus to the preceding text gap in this composer.
    focusRequest = EditorFocusRequest(blockID: textIDs[ordinal])
    changed()
  }

  private(set) var document = ChatDraftDocument()
  let attachments: AttachmentDraftStore
  let editor = ComposerEditor()
  var error: String? { localError ?? syncError }
  private var localReadFailed = false
  private var localError: String?
  private var syncError: String?
  private(set) var conflictingRemote: ComposerDraft?
  var contextLabels: [String] { document.contextLabels }
  var canSend: Bool {
    let ids = Set(
      document.parts.compactMap { $0["type"]?.string == "file" ? $0["fileId"]?.string : nil })
    return document.isSupported && !localReadFailed && conflictingRemote == nil
      && ids.isSubset(of: Set(attachments.uploaded.map(\.id)))
  }
  var hasContent: Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || document.parts.contains { $0["type"]?.string != "text" }
      || attachments.hasAttachments
  }
  var isDurable: Bool {
    storage != nil && localError == nil && attachments.importingCount == 0
      && !attachments.items.contains { if case .uploading = $0.state { true } else { false } }
  }
  func requestSync() {
    guard !closed, isForeground, !Task.isCancelled, syncTask == nil else { return }
    Task { [weak self] in await self?.synchronize() }
  }

  func setForeground(_ active: Bool) {
    guard !closed, isForeground != active else { return }
    isForeground = active
    if active {
      // Resume pending writes, including clears owned by a different cached composer.
      if dirty { requestSync() }
    } else {
      persist()
      debounceTask?.cancel()
      // A cancelled task can finish after the next foreground sync has started.
      syncGeneration = UUID()
      syncTask?.cancel()
      syncTask = nil
    }
  }
  private let target: ChatDraftTarget
  private let repository: ChatDraftRepository?
  private let storage: ChatDraftStorage?
  private let didFail: @MainActor (Error) -> Void
  private var metadata: [ComposerDraft.DraftAttachment] = []
  private var baseline: ComposerDraft?
  private var dirty = false
  private var cleared = false
  private var revision = 0
  private var applying = false
  private var closed = false
  private var isForeground = true
  private var syncGeneration = UUID()
  private var debounceTask: Task<Void, Never>?
  private var syncTask: Task<Void, Never>?

  init(
    target: ChatDraftTarget, commands: ChatCommands, repository: ChatDraftRepository? = nil,
    storage: ChatDraftStorage? = nil, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.target = target
    self.repository = repository
    self.storage = storage
    self.didFail = didFail
    attachments = AttachmentDraftStore(commands: commands, didFail: didFail)
    do {
      if let saved = try storage?.load(target.key, as: LocalRecord.self) {
        document = saved.value.draftUserMessage ?? ChatDraftDocument()
        metadata = saved.value.draftAttachments ?? []
        baseline = saved.baseline
        dirty = saved.dirty
        cleared = saved.cleared
        attachments.restore(saved.files)
      }
    } catch {
      localReadFailed = true
      localError =
        "Cannot restore the device draft. Clear it explicitly to start again. "
        + error.localizedDescription
      didFail(error)
    }
    resetEditors()
    attachments.didChange = { [weak self] in self?.changed() }
    attachments.didRemove = { [weak self] fileID in
      guard let self, let fileID else { return }
      document.parts.removeAll { $0["type"]?.string == "file" && $0["fileId"]?.string == fileID }
      metadata.removeAll { $0.id == fileID }
      changed()
    }
  }

  var value: ComposerDraft {
    var result = document
    let files = attachments.savedItems.compactMap(\.uploaded)
    let existing = Set(
      result.parts.compactMap { $0["type"]?.string == "file" ? $0["fileId"]?.string : nil })
    for file in files where !existing.contains(file.id) {
      result.parts.append(
        .object([
          "type": .string("file"), "fileId": .string(file.id),
          "filenameSnapshot": .string(file.filename), "contentType": .string(file.contentType),
        ]))
    }
    var persisted = metadata
    for file in files {
      guard let url = file.url else { continue }
      persisted.removeAll { $0.id == file.id }
      persisted.append(ComposerDraft.DraftAttachment(attachment: file, url: url))
    }
    return ComposerDraft(
      document: result.parts.isEmpty ? nil : result,
      attachments: persisted.isEmpty ? nil : persisted)
  }

  private func changed() {
    guard !closed, !applying else { return }
    revision += 1
    dirty = true
    if hasContent { cleared = false }
    persist()
    debounceTask?.cancel()
    guard isForeground else { return }
    debounceTask = Task { [weak self] in
      do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
      await self?.synchronize()
    }
  }

  private func persist() {
    guard !closed, !localReadFailed else { return }
    do {
      try storage?.save(
        LocalRecord(
          value: value, files: attachments.savedItems,
          baseline: baseline, dirty: dirty, cleared: cleared), key: target.key)
      localError = nil
    } catch {
      localError = "Cannot save this draft on the device. " + error.localizedDescription
      didFail(error)
    }
  }

  func synchronize() async {
    guard !closed, isForeground, !Task.isCancelled, !localReadFailed, let repository else { return }
    if let syncTask {
      await syncTask.value
      return
    }
    let generation = syncGeneration
    let task = Task { [weak self] in
      guard let self else { return }
      defer {
        if syncGeneration == generation { syncTask = nil }
      }
      repeat {
        let startedRevision = revision
        do {
          let remote = try await repository.load(target)
          try Task.checkCancellation()
          guard !closed else { return }
          if dirty {
            // The API has no conditional writes. Refuse a known changed snapshot on reconnect;
            // overlapping writes after this read still follow the API's last-writer semantics.
            let changedElsewhere = baseline.map { $0 != remote } ?? (remote != ComposerDraft())
            if changedElsewhere && remote != value
              && (baseline != nil || startedRevision == revision)
            {
              conflictingRemote = remote
              syncError = "This draft changed on another device. Choose which draft to keep."
              persist()
              return
            }
          } else if startedRevision == revision {
            if cleared && remote != value {
              conflictingRemote = remote
              syncError =
                "A draft appeared after this device cleared it. Choose which draft to keep."
              persist()
              return
            }
            // Providers can still be preparing their file. Preserve that action
            // through the same conflict path as interrupted local attachments.
            if revision == 0 && attachments.importingCount == 0
              && !attachments.savedItems.contains(where: { $0.uploaded == nil })
            {
              if remote != value { apply(remote) }
            } else if remote != baseline && remote != value {
              conflictingRemote = remote
              syncError = "This draft changed on another device. Choose which draft to keep."
              persist()
              return
            }
          }
          baseline = remote
          guard document.isSupported else {
            syncError = "This draft contains content this app cannot edit. Open it on the web."
            persist()
            return
          }
          guard dirty else {
            syncError = nil
            persist()
            return
          }
          let sentRevision = revision
          let sent = value
          try await repository.save(sent, to: target)
          try Task.checkCancellation()
          guard !closed else { return }
          baseline = sent
          if sentRevision == revision { dirty = false }
          conflictingRemote = nil
          syncError = nil
          persist()
        } catch is CancellationError { return } catch {
          guard !closed, !Task.isCancelled else { return }
          report(error)
          persist()
          return
        }
      } while dirty && !closed && !Task.isCancelled
    }
    syncTask = task
    await task.value
  }

  private func apply(_ remote: ComposerDraft) {
    applying = true
    document = remote.draftUserMessage ?? ChatDraftDocument()
    metadata = remote.draftAttachments ?? []
    resetEditors()
    cleared = false
    attachments.restoreRemote(remote)
    applying = false
  }

  func useRemote() {
    guard let remote = conflictingRemote else { return }
    revision += 1
    apply(remote)
    baseline = remote
    dirty = false
    conflictingRemote = nil
    syncError = nil
    persist()
  }

  func keepLocal() {
    guard let remote = conflictingRemote else { return }
    baseline = remote
    conflictingRemote = nil
    syncError = nil
    changed()
  }

  func clear() {
    guard !closed else { return }
    // Native focus callbacks must finish while their editor generation is still current.
    editor.dismissKeyboard()
    localReadFailed = false
    cleared = true
    applying = true
    document = ChatDraftDocument()
    resetEditors()
    metadata = []
    attachments.reset()
    applying = false
    if let conflictingRemote { baseline = conflictingRemote }
    conflictingRemote = nil
    changed()
  }

  func move(to destination: ComposerDraftStore) {
    destination.applying = true
    destination.document = value.draftUserMessage ?? ChatDraftDocument()
    destination.metadata = value.draftAttachments ?? []
    destination.resetEditors()
    attachments.moveReadyFiles(to: destination.attachments)
    destination.applying = false
    destination.changed()
    clear()
  }

  func close() {
    guard !closed else { return }
    persist()
    editor.dismissKeyboard()
    editor.mentionSource = nil
    closed = true
    debounceTask?.cancel()
    syncTask?.cancel()
    attachments.close(preserveFiles: storage != nil)
  }

  private func report(_ failure: Error) {
    didFail(failure)
    if let transport = failure as? URLError {
      switch transport.code {
      case .cancelled, .timedOut, .notConnectedToInternet, .networkConnectionLost,
        .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed:
        return
      default: break
      }
    }
    let status = (failure as? APIClientError)?.statusCode
    guard status != 401, status != 426 else { return }
    syncError = "Draft sync unavailable. " + failure.localizedDescription
  }
}
