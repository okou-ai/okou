import ChatData
import ChatDomain
import Foundation
import Observation
import UIKit

/// Detail-scoped downloads. Leaving the detail or closing its workspace cancels all work.
@MainActor @Observable
final class MessageAttachmentStore {
  private(set) var preview: MessageAttachmentPreviewResource?
  private let commands: ChatCommands
  private let didFail: @MainActor (Error) -> Void
  private(set) var reads: MessageAttachmentResources
  private var closed = false

  init(commands: ChatCommands, didFail: @escaping @MainActor (Error) -> Void) {
    self.commands = commands
    self.didFail = didFail
    reads = MessageAttachmentResources(commands: commands, didFail: didFail)
  }

  func cachedThumbnail(_ attachment: ChatMessageAttachment) -> UIImage? {
    guard !closed else { return nil }
    return reads.cachedThumbnail(attachment)
  }

  func open(_ attachment: ChatMessageAttachment) {
    guard !closed else { return }
    preview?.close()
    preview = MessageAttachmentPreviewResource(
      attachment: attachment, thumbnail: cachedThumbnail(attachment),
      commands: commands, didFail: didFail)
  }

  func dismiss() {
    preview?.close()
    preview = nil
  }

  func deactivate() {
    dismiss()
    reads.close()
    if !closed { reads = MessageAttachmentResources(commands: commands, didFail: didFail) }
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
