import Foundation

@MainActor
final class ConversationLiveOutput {
  typealias Subscribe = (
    String, @escaping @MainActor @Sendable (RealtimeService.RunOutputDelta) -> Void
  ) -> (@MainActor () -> Void)?
  private typealias StreamedOutput = ConversationStore.StreamedOutput
  private let threadID: String
  private let lifecycleTasks: LifecycleTasks
  private let isPersisted: @MainActor (String) -> Bool
  private let publish: @MainActor ([ConversationStore.StreamedOutput]) -> Void
  private var streamRunID: String?
  private var streamStop: (@MainActor () -> Void)?
  private var streamBuffer: [String: StreamedOutput] = [:]
  private var streamOrder: [String] = []
  private var streamFlush: Task<Void, Never>?
  private var closed = false

  init(
    threadID: String, lifecycleTasks: LifecycleTasks,
    isPersisted: @escaping @MainActor (String) -> Bool,
    publish: @escaping @MainActor ([ConversationStore.StreamedOutput]) -> Void
  ) {
    self.threadID = threadID
    self.lifecycleTasks = lifecycleTasks
    self.isPersisted = isPersisted
    self.publish = publish
  }

  func reconcile(runID: String?, subscribe: Subscribe?) {
    // Retry on the next history change when realtime was not connected yet.
    if runID != streamRunID || (runID != nil && streamStop == nil) {
      streamStop?()
      streamStop = nil
      streamBuffer = [:]
      streamOrder = []
      if let runID {
        streamStop = subscribe?(runID) { [weak self] delta in self?.receiveStream(delta) }
      }
      streamRunID = streamStop == nil ? nil : runID
    }
    publishStream()
  }

  private func receiveStream(_ delta: RealtimeService.RunOutputDelta) {
    // Only the Pi framework (Auto, on Okou credits) streams; other frameworks deliver
    // whole messages as durable events, which already render.
    guard !closed, delta.runID == streamRunID, delta.threadID == threadID.lowercased(),
      !isPersisted(delta.eventID)
    else { return }
    if delta.chunkIndex == 0 {
      if streamBuffer[delta.eventID] == nil { streamOrder.append(delta.eventID) }
      streamBuffer[delta.eventID] = StreamedOutput(
        eventID: delta.eventID, runID: delta.runID, text: delta.delta, createdAt: .now)
    } else if var output = streamBuffer[delta.eventID] {
      output.text += delta.delta
      streamBuffer[delta.eventID] = output
    } else {
      return
    }
    // About eight layouts a second: every chunk would re-measure the row each time.
    guard streamFlush == nil else { return }
    streamFlush = Task { [weak self] in
      try? await Task.sleep(for: OkouMotion.streamFlush)
      guard let self, !Task.isCancelled else { return }
      self.streamFlush = nil
      self.publishStream()
    }
    if let streamFlush { lifecycleTasks.track(streamFlush) }
  }

  private func publishStream() {
    publish(streamOrder.compactMap { streamBuffer[$0] })
  }

  func close() {
    closed = true
    streamStop?()
    streamStop = nil
    streamFlush?.cancel()
  }
}
