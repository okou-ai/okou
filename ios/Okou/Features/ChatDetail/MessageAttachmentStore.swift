import CCState
import ChatData
import ChatDomain
import Foundation
import UIKit

/// Detail-scoped downloads. Leaving the detail or closing its workspace cancels all work. The
/// open preview and the current reads are kept in the workspace session's Store.
@MainActor
final class MessageAttachmentStore {
  /// What views present: the open preview and the reads attachment rows use. Both compare by
  /// identity.
  struct Presentation: Equatable {
    var preview: MessageAttachmentPreviewResource?
    var reads: MessageAttachmentResources

    static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.preview === rhs.preview && lhs.reads === rhs.reads
    }
  }

  /// Views resolve it; `preview` and `reads` serve actions and tests.
  let presentationValue: Computed<Presentation>
  /// The current reads alone, so transcript rows follow a replacement but not a preview.
  let readsValue: Computed<MessageAttachmentResources>
  /// The workspace session's Store, which keeps the reads' graph values and the presentation.
  let graph: CCState.Store
  private let presentationState: CCState.State<Presentation>
  private let commands: ChatCommands
  private let didFail: @MainActor (Error) -> Void
  private var closed = false

  init(
    commands: ChatCommands, graph: CCState.Store, didFail: @escaping @MainActor (Error) -> Void
  ) {
    self.commands = commands
    self.graph = graph
    self.didFail = didFail
    let presentationState = CCState.State(
      Presentation(
        reads: MessageAttachmentResources(commands: commands, graph: graph, didFail: didFail)))
    self.presentationState = presentationState
    presentationValue = Computed { try $0(presentationState) }
    readsValue = Computed(equals: { $0 === $1 }, { get in try get(presentationState).reads })
  }

  var presentation: Presentation {
    // A synchronous local value, not a network or persistence boundary.
    do { return try graph.get(presentationValue) } catch {
      preconditionFailure("Cannot read the attachment viewer: \(error)")
    }
  }
  var preview: MessageAttachmentPreviewResource? { presentation.preview }
  var reads: MessageAttachmentResources { presentation.reads }

  private func update(_ change: (inout Presentation) -> Void) {
    var next = presentation
    change(&next)
    guard next != presentation else { return }
    do { try graph.set(presentationState, next) } catch {
      preconditionFailure("Cannot publish the attachment viewer: \(error)")
    }
  }

  func cachedThumbnail(_ attachment: ChatMessageAttachment) -> UIImage? {
    guard !closed else { return nil }
    return reads.cachedThumbnail(attachment)
  }

  func open(_ attachment: ChatMessageAttachment) {
    guard !closed else { return }
    preview?.close()
    let next = MessageAttachmentPreviewResource(
      attachment: attachment, thumbnail: cachedThumbnail(attachment),
      commands: commands, graph: graph, didFail: didFail)
    update { $0.preview = next }
  }

  func dismiss() {
    preview?.close()
    update { $0.preview = nil }
  }

  func deactivate() {
    dismiss()
    reads.close()
    if !closed {
      let next = MessageAttachmentResources(commands: commands, graph: graph, didFail: didFail)
      update { $0.reads = next }
    }
  }

  func close() {
    closed = true
    deactivate()
  }

  static func message(for error: Error) -> String {
    switch (error as? APIClientError)?.statusCode {
    case 403: "You do not have permission to view this attachment."
    case 404, 410: "This attachment was deleted or is no longer available."
    default: ChatRequestFailure.message(for: error)
    }
  }
}
