import ChatDomain
import Foundation
import Synchronization

/// Disposable file bytes owned by one workspace, shared by uploads, cards and previews.
final class ChatFileCache: Sendable {
  private struct Entry {
    let file: ChatAttachmentFile
    let uploaded: Bool
    var access: UInt64
  }

  private struct State {
    var entries: [ChatArtifact.Source: Entry] = [:]
    var size = 0
    var clock: UInt64 = 0
    var closed = false
  }

  private let state = Mutex(State())
  private let maximumSize = 256 * 1024 * 1024
  private let maximumCount = 64

  func file(for source: ChatArtifact.Source, uploadedOnly: Bool = false) -> ChatAttachmentFile? {
    state.withLock { state in
      guard !state.closed, var entry = state.entries[source] else { return nil }
      guard FileManager.default.fileExists(atPath: entry.file.url.path) else {
        state.entries[source] = nil
        state.size -= entry.file.size
        return nil
      }
      guard !uploadedOnly || entry.uploaded else { return nil }
      state.clock &+= 1
      entry.access = state.clock
      state.entries[source] = entry
      return entry.file
    }
  }

  func insert(_ file: ChatAttachmentFile, for source: ChatArtifact.Source, uploaded: Bool = false) {
    guard file.size <= maximumSize else { return }
    state.withLock { state in
      guard !state.closed else { return }
      if let previous = state.entries.removeValue(forKey: source) {
        state.size -= previous.file.size
      }
      state.clock &+= 1
      state.entries[source] = Entry(file: file, uploaded: uploaded, access: state.clock)
      state.size += file.size
      while state.size > maximumSize || state.entries.count > maximumCount {
        guard let oldest = state.entries.min(by: { $0.value.access < $1.value.access }) else {
          break
        }
        state.size -= oldest.value.file.size
        state.entries[oldest.key] = nil
      }
    }
  }

  func close() {
    state.withLock { state in
      state.closed = true
      state.entries.removeAll()
      state.size = 0
    }
  }
}
