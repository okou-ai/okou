import ChatData
import ChatDomain
import Foundation

/// Synchronization and device-storage outcomes shown beside a composer draft.
struct ComposerDraftStatus: Equatable {
  var localReadFailed = false
  var localError: String?
  var syncError: String?
  var syncWarning: String?
  var conflictingRemote: ComposerDraft?
  var isForeground = true
}

/// What the composer UI reads in one render: the draft, its uploads and its voice input.
struct ComposerDraftPresentation: Equatable {
  let draft: ComposerDraftSignals.Content
  let editorBlocks: [ComposerEditorBlock]
  let status: ComposerDraftStatus
  let attachments: AttachmentDraftStore.Content
  let voicePhase: ComposerVoiceInputStore.Phase?
  let voiceHasError: Bool
  let hasContent: Bool
  let canSend: Bool
  let canEditVoice: Bool

  var text: String { draft.document.text }
  var error: String? { status.localError ?? status.syncError }
  var hasLocalFailure: Bool { status.localError != nil }
  var canRetryLocalSave: Bool { !status.localReadFailed }
}

/// Rules derived from one draft's content, sync status, uploads and voice input. The composer
/// graph and its owner's synchronous accessors apply the same rules.
enum ComposerDraftRules {
  static func hasContent(
    _ draft: ComposerDraftSignals.Content, _ uploads: AttachmentDraftStore.Content
  ) -> Bool {
    !draft.document.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      || draft.document.parts.contains { $0["type"]?.string != "text" }
      || uploads.hasAttachments
  }

  static func canSend(
    _ draft: ComposerDraftSignals.Content, _ status: ComposerDraftStatus,
    _ uploads: AttachmentDraftStore.Content, _ voice: ComposerVoiceInputStore.Content?
  ) -> Bool {
    let document = draft.document
    let ids = Set(
      document.parts.compactMap { $0["type"]?.string == "file" ? $0["fileId"]?.string : nil })
    return document.isSupported && !status.localReadFailed && status.conflictingRemote == nil
      && (voice == nil || voice?.phase == .idle)
      && ids.isSubset(of: Set(uploads.uploaded.map(\.id)))
  }

  static func isDurable(
    persistent: Bool, _ status: ComposerDraftStatus, _ uploads: AttachmentDraftStore.Content
  ) -> Bool {
    persistent && status.localError == nil && uploads.importingCount == 0
      && !uploads.items.contains { if case .uploading = $0.state { true } else { false } }
  }

  static func canEditDocument(
    _ draft: ComposerDraftSignals.Content, _ status: ComposerDraftStatus
  ) -> Bool {
    !draft.closed && status.isForeground && draft.document.isSupported
      && !status.localReadFailed && status.conflictingRemote == nil
  }
}

/// One native editor's slice of the canonical draft: a text gap or a quoted feedback note.
struct ComposerEditorBlock: Identifiable, Equatable {
  let id: UUID
  let indices: Range<Int>
  let quote: String?
  let content: ChatDraftDocument
  var isFeedback: Bool { quote != nil }
  var hasParagraph: Bool {
    content.parts.contains(where: ComposerAttributedDocument.isInline)
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
