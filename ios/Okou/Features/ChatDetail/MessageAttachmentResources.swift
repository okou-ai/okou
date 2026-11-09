import CCState
import ChatData
import ChatDomain
import Foundation
import UIKit

@MainActor
final class MessageAttachmentThumbnail {
  let image: UIImage?

  init(image: UIImage?) { self.image = image }

  var cost: Int {
    guard let image else { return 0 }
    return Int(image.size.width * image.scale) * Int(image.size.height * image.scale) * 4
  }
}

/// One detail visit owns shared thumbnail reads; the cache owns their retention budget.
@MainActor
final class MessageAttachmentResources {
  let store = CCState.Store()
  fileprivate let lifetime = CCState.State(true)
  private let cache: NSCache<NSString, MessageAttachmentThumbnailRead> = {
    let cache = NSCache<NSString, MessageAttachmentThumbnailRead>()
    cache.totalCostLimit = 16 * 1024 * 1024
    cache.countLimit = 64
    return cache
  }()
  private final class WeakRead {
    weak var value: MessageAttachmentThumbnailRead?
    init(_ value: MessageAttachmentThumbnailRead) { self.value = value }
  }
  private var live: [String: WeakRead] = [:]
  private let commands: ChatCommands
  private let didFail: @MainActor (Error) -> Void
  private var pending: [String: MessageAttachmentThumbnailRead] = [:]
  private var closed = false

  init(commands: ChatCommands, didFail: @escaping @MainActor (Error) -> Void) {
    self.commands = commands
    self.didFail = didFail
  }

  func thumbnail(_ attachment: ChatMessageAttachment) -> MessageAttachmentThumbnailRead {
    let key = attachment.downloadID
    if let read = pending[key] ?? live[key]?.value { return read }
    live = live.filter { $0.value.value != nil }
    let read = MessageAttachmentThumbnailRead(owner: self, attachment: attachment)
    if !closed {
      live[key] = WeakRead(read)
      cache.setObject(read, forKey: key as NSString)
    }
    return read
  }

  func cachedThumbnail(_ attachment: ChatMessageAttachment) -> UIImage? {
    guard !closed else { return nil }
    return cache.object(forKey: attachment.downloadID as NSString)?.thumbnail?.image
  }

  func retryIfNeeded(_ read: MessageAttachmentThumbnailRead) {
    guard !closed else { return }
    if read.failed || read.thumbnail.map({ $0.image == nil }) == true {
      do { try read.retry(in: store) } catch { didFail(error) }
    }
  }

  fileprivate func started(_ read: MessageAttachmentThumbnailRead) {
    pending[read.attachment.downloadID] = read
  }

  fileprivate func finished(_ read: MessageAttachmentThumbnailRead) {
    let key = read.attachment.downloadID
    if pending[key] === read { pending[key] = nil }
  }

  fileprivate func load(_ read: MessageAttachmentThumbnailRead) async throws
    -> MessageAttachmentThumbnail
  {
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    let file: ChatAttachmentFile?
    do {
      file = try await commands.downloadAttachment(read.attachment, thumbnail: true)
    } catch {
      if !closed, !Task.isCancelled,
        let status = (error as? APIClientError)?.statusCode, [401, 426].contains(status)
      {
        didFail(error)
      }
      throw error
    }
    let data: Data?
    if let file {
      data = await AttachmentFileImporter.shared.thumbnail(file.url, maximumPixelSize: 600)
    } else {
      data = nil
    }
    try Task.checkCancellation()
    guard !closed else { throw CancellationError() }
    let thumbnail = MessageAttachmentThumbnail(image: data.flatMap(UIImage.init(data:)))
    read.thumbnail = thumbnail
    // Evicting an unobserved read releases its signal and the Store's cached Task/result.
    // Mounted rows may retain their own image, as they did before this resource graph.
    cache.setObject(read, forKey: read.attachment.downloadID as NSString, cost: thumbnail.cost)
    return thumbnail
  }

  func close() {
    guard !closed else { return }
    closed = true
    for read in pending.values { read.cancel() }
    pending = [:]
    cache.removeAllObjects()
    live = [:]
    // Mounted consumers must also stop displaying a retired detail's result.
    do { try store.set(lifetime, false) } catch { didFail(error) }
  }
}

/// The graph retains the result; the weak thumbnail is only a synchronous preview lookup.
@MainActor
final class MessageAttachmentThumbnailRead {
  fileprivate let attachment: ChatMessageAttachment
  fileprivate weak var thumbnail: MessageAttachmentThumbnail?
  fileprivate var failed = false
  private weak var owner: MessageAttachmentResources?
  private let revision = CCState.State(0)
  private let reload: Command<Void, Void>
  private var request: Task<MessageAttachmentThumbnail, Error>?

  fileprivate init(owner: MessageAttachmentResources, attachment: ChatMessageAttachment) {
    self.owner = owner
    self.attachment = attachment
    let revision = revision
    reload = Command { context in try context.set(revision, update: { $0 + 1 }) }
  }

  lazy var value = makeValue()

  private func makeValue() -> Computed<Task<MessageAttachmentThumbnail, Error>> {
    Computed { [weak self] get, options in
      guard let self, let owner, try get(owner.lifetime) else { throw CancellationError() }
      _ = try get(revision)
      failed = false
      thumbnail = nil
      let signal = options.signal
      owner.started(self)
      let task = Task<MessageAttachmentThumbnail, Error> { @MainActor [self, owner] in
        defer { owner.finished(self) }
        do {
          let thumbnail = try await owner.load(self)
          try Task.checkCancellation()
          try signal.checkCancellation()
          return thumbnail
        } catch {
          if !Task.isCancelled { failed = true }
          throw error
        }
      }
      request = task
      signal.onCancel { task.cancel() }
      return task
    }
  }

  fileprivate func retry(in store: CCState.Store) throws {
    cancel()
    try store.set(reload)
  }

  fileprivate func cancel() { request?.cancel() }
  isolated deinit { request?.cancel() }
}
