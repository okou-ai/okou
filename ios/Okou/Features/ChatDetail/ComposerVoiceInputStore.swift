import ChatData
import Foundation
import Observation

/// Capture, transcription and insertion belong to one draft, including while its view unmounts.
@MainActor @Observable
final class ComposerVoiceInputStore {
  enum Phase { case idle, starting, recording, processing, saved }
  private(set) var phase = Phase.idle
  private(set) var duration: Double = 0
  private(set) var levels: [Float] = []
  private(set) var error: String?
  private(set) var microphoneDenied = false
  var isWorking: Bool { phase == .starting || phase == .recording || phase == .processing }
  var canUseRecording: Bool { session != nil && recordingID != nil }
  weak var composer: ComposerDraftStore?
  private let client: VoiceInputClient
  private let storage: VoiceDraftStorage
  private let capture: any VoiceAudioCapture
  private let didRequireUpgrade: @MainActor (Error) -> Void
  private var session: VoiceDraftSession?
  private var recordingID: UUID?
  private var insertion: ComposerEditor.VoiceInsertion?
  private var generation = UUID()
  private var startingTask: Task<Void, Never>?
  private var quotaTask: Task<Void, Error>?
  private var quotaAllowed = false
  private var captureTask: Task<Void, Error>?
  private var transcriptionTask: Task<Void, Never>?
  private var preparationTask: Task<String, Error>?
  private var transcriptionFailed = false

  init(
    client: VoiceInputClient, storage: VoiceDraftStorage,
    capture: any VoiceAudioCapture = NativeVoiceAudioCapture(),
    didRequireUpgrade: @escaping @MainActor (Error) -> Void
  ) {
    self.client = client
    self.storage = storage
    self.capture = capture
    self.didRequireUpgrade = didRequireUpgrade
    restore()
  }

  private func report(_ failure: Error) {
    error = failure.localizedDescription
    if (failure as? APIClientError)?.statusCode == 426 { didRequireUpgrade(failure) }
  }

  private func restore() {
    do {
      let session = try VoiceDraftSession(
        client: client, storage: storage, activityDetection: NativeVoiceActivityDetection())
      self.session = session
      recordingID = session.restoredRecordingID
      duration = session.restoredDuration
      phase = storage.hasRecording ? .saved : .idle
    } catch {
      phase = .saved
      self.error = "Cannot restore this recording. " + error.localizedDescription
    }
  }

  func start() async {
    guard phase == .idle, let composer, composer.canEditVoice else { return }
    guard let target = composer.editor.voiceInsertion() else {
      error = "Finish editing before starting voice input."
      return
    }
    let owner = UUID()
    generation = owner
    phase = .starting
    quotaAllowed = false
    error = nil
    microphoneDenied = false
    let starting = Task { await begin(composer: composer, target: target, owner: owner) }
    startingTask = starting
    await starting.value
    if generation == owner { startingTask = nil }
  }

  private func begin(
    composer: ComposerDraftStore, target: ComposerEditor.VoiceInsertion, owner: UUID
  ) async {
    let quota = checkQuota()
    quotaTask = quota
    do {
      let stream = try await capture.start()
      guard generation == owner, composer.canEditVoice else {
        quota.cancel()
        capture.stop()
        if generation == owner { phase = .idle }
        return
      }
      guard let session else { throw VoiceDraftError.unavailable }
      let id = try await session.begin(context: target.context)
      recordingID = id
      insertion = target
      duration = 0
      levels = []
      transcriptionFailed = false
      captureTask = Task { [weak self] in
        do {
          for try await chunk in stream {
            let duration = try await session.append(chunk.pcm, recordingID: id)
            guard let self else { return }
            self.duration = duration
            levels = Array((levels + [chunk.level]).suffix(32))
            if phase == .recording { transcribeAvailable(id: id, owner: owner) }
          }
          if let self, generation == owner, phase == .recording {
            phase = .saved
            error = "Recording paused. Use the saved recording when you're ready."
          }
        } catch {
          if let self {
            capture.stop()
            if generation == owner {
              phase = .saved
              self.error = error.localizedDescription
            }
          }
          throw error
        }
      }
      if generation == owner {
        phase = .recording
        composer.editor.dismissKeyboard()
      } else {
        quota.cancel()
        capture.stop()
        if phase == .idle { phase = .saved }
      }
    } catch {
      quota.cancel()
      guard generation == owner else { return }
      capture.stop()
      phase = storage.hasRecording ? .saved : .idle
      report(error)
      if case NativeVoiceAudioCapture.CaptureError.permissionDenied = error {
        microphoneDenied = true
      }
      return
    }
    do {
      try await quota.value
      guard generation == owner, !Task.isCancelled else { return }
      quotaAllowed = true
      if phase == .recording, let id = recordingID {
        transcribeAvailable(id: id, owner: owner)
      }
    } catch {
      // Finishing owns its own failure; a pending check must never upload audio.
      guard generation == owner, phase == .recording else { return }
      phase = .processing
      capture.stop()
      _ = await captureTask?.result
      guard generation == owner else { return }
      captureTask = nil
      phase = .saved
      reportQuotaFailure(error)
    }
  }

  private func checkQuota() -> Task<Void, Error> {
    Task { [client] in
      let quota = try await client.quota()
      try Task.checkCancellation()
      guard quota.allowed else {
        throw APIClientError.http(
          status: 402, message: "Your voice input limit has been reached.",
          code: "AUDIO_INPUT_QUOTA_EXCEEDED")
      }
    }
  }

  private func reportQuotaFailure(_ failure: Error) {
    report(failure)
    error = failure.localizedDescription + " Your recording is saved. Use it to retry."
  }

  private func transcribeAvailable(id: UUID, owner: UUID) {
    guard quotaAllowed, transcriptionTask == nil, !transcriptionFailed, let session else { return }
    transcriptionTask = Task { [weak self] in
      defer { self?.transcriptionTask = nil }
      do { try await session.transcribeAvailable(recordingID: id) } catch {
        guard let self, generation == owner, !(error is CancellationError) else { return }
        if (error as? APIClientError)?.statusCode == 426 {
          suspend()
          report(error)
          return
        }
        transcriptionFailed = true
        self.error = "Transcription delayed. Your recording is being saved."
      }
    }
  }

  func finish() async {
    guard phase == .recording || phase == .saved,
      let composer, composer.canEditVoice, let session, let id = recordingID
    else { return }
    let usingSavedRecording = phase == .saved
    if usingSavedRecording { insertion = composer.editor.voiceInsertion() }
    guard insertion != nil else {
      error = "Finish editing and place the cursor where you want to insert the recording."
      return
    }
    let owner = generation
    phase = .processing
    error = nil
    defer {
      // A remote draft conflict can make insertion unavailable during HTTP work.
      if generation == owner, phase == .processing { phase = .saved }
    }
    capture.stop()
    do {
      try await captureTask?.value
      captureTask = nil
      await transcriptionTask?.value
      _ = await preparationTask?.result
      let hasPreparedText = await session.hasPreparedText
      guard generation == owner, composer.canEditVoice else { return }
      if !hasPreparedText {
        if usingSavedRecording {
          quotaTask?.cancel()
          quotaTask = checkQuota()
          quotaAllowed = false
        }
        guard let quotaTask else { throw VoiceDraftError.unavailable }
        do { try await quotaTask.value } catch {
          guard generation == owner else { return }
          phase = .saved
          reportQuotaFailure(error)
          return
        }
        guard generation == owner, composer.canEditVoice else { return }
      }
      let preparation = Task { try await session.finish(recordingID: id) }
      preparationTask = preparation
      let text = try await preparation.value
      guard generation == owner, composer.canEditVoice else { return }
      if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
        let insertion, !composer.insertVoiceText(text, id: id, at: insertion)
      {
        phase = .saved
        error =
          "Your draft changed. Place the cursor and use the saved recording to insert its text."
        return
      }
      // The draft records the consumed ID in the same atomic save as its text.
      // A failed audio cleanup can therefore never insert this recording twice.
      if !text.isEmpty, composer.hasLocalFailure {
        phase = .saved
        error = "Text was inserted. Save the draft on this device before discarding the recording."
        return
      }
      try await session.discard()
      guard generation == owner else { return }
      recordingID = nil
      insertion = nil
      phase = .idle
      if text.isEmpty { error = "No speech detected." }
    } catch {
      guard generation == owner else { return }
      captureTask = nil
      phase = .saved
      report(error)
    }
  }

  func discard() async {
    generation = UUID()
    let owner = generation
    phase = .processing
    capture.stop()
    startingTask?.cancel()
    quotaTask?.cancel()
    transcriptionTask?.cancel()
    preparationTask?.cancel()
    await startingTask?.value
    _ = await quotaTask?.result
    _ = await captureTask?.result
    await transcriptionTask?.value
    _ = await preparationTask?.result
    guard generation == owner else { return }
    do {
      if let session { try await session.discard() } else { try storage.remove() }
      guard generation == owner else { return }
      error = nil
      insertion = nil
      recordingID = nil
      restore()
    } catch {
      guard generation == owner else { return }
      phase = .saved
      self.error = error.localizedDescription
    }
  }

  func suspend() {
    generation = UUID()
    let owner = generation
    capture.stop()
    startingTask?.cancel()
    quotaTask?.cancel()
    transcriptionTask?.cancel()
    preparationTask?.cancel()
    insertion = nil
    guard phase != .idle else { return }
    phase = .processing
    let startingTask = startingTask
    let quotaTask = quotaTask
    let captureTask = captureTask
    let transcriptionTask = transcriptionTask
    let preparationTask = preparationTask
    Task { [weak self] in
      await startingTask?.value
      _ = await quotaTask?.result
      _ = await captureTask?.result
      await transcriptionTask?.value
      _ = await preparationTask?.result
      guard let self, generation == owner else { return }
      self.startingTask = nil
      self.quotaTask = nil
      self.captureTask = nil
      self.transcriptionTask = nil
      self.preparationTask = nil
      phase = storage.hasRecording ? .saved : .idle
    }
  }
}
