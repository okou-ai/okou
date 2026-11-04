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
  private var session: VoiceDraftSession?
  private var recordingID: UUID?
  private var insertion: ComposerEditor.VoiceInsertion?
  private var generation = UUID()
  private var startingTask: Task<Void, Never>?
  private var captureTask: Task<Void, Error>?
  private var transcriptionTask: Task<Void, Never>?
  private var preparationTask: Task<String, Error>?
  private var transcriptionFailed = false

  init(
    client: VoiceInputClient, storage: VoiceDraftStorage,
    capture: any VoiceAudioCapture = NativeVoiceAudioCapture()
  ) {
    self.client = client
    self.storage = storage
    self.capture = capture
    restore()
  }

  private func restore() {
    do {
      let session = try VoiceDraftSession(client: client, storage: storage)
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
    do {
      let quota = try await client.quota()
      guard generation == owner else { return }
      guard composer.canEditVoice else {
        phase = .idle
        return
      }
      guard quota.allowed else {
        throw APIClientError.http(
          status: 402, message: "Your voice input limit has been reached.",
          code: "AUDIO_INPUT_QUOTA_EXCEEDED")
      }
      let stream = try await capture.start()
      guard generation == owner, composer.canEditVoice else {
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
        capture.stop()
        if phase == .idle { phase = .saved }
      }
    } catch {
      guard generation == owner else { return }
      capture.stop()
      phase = storage.hasRecording ? .saved : .idle
      self.error = error.localizedDescription
      if case NativeVoiceAudioCapture.CaptureError.permissionDenied = error {
        microphoneDenied = true
      }
    }
  }

  private func transcribeAvailable(id: UUID, owner: UUID) {
    guard transcriptionTask == nil, !transcriptionFailed, let session else { return }
    transcriptionTask = Task { [weak self] in
      defer { self?.transcriptionTask = nil }
      do { try await session.transcribeAvailable(recordingID: id) } catch {
        guard let self, generation == owner, !(error is CancellationError) else { return }
        transcriptionFailed = true
        self.error = "Transcription delayed. Your recording is being saved."
      }
    }
  }

  func finish() async {
    guard phase == .recording || phase == .saved,
      let composer, composer.canEditVoice, let session, let id = recordingID
    else { return }
    if phase == .saved { insertion = composer.editor.voiceInsertion() }
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
      guard generation == owner, composer.canEditVoice else { return }
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
      self.error = error.localizedDescription
    }
  }

  func discard() async {
    generation = UUID()
    let owner = generation
    phase = .processing
    capture.stop()
    startingTask?.cancel()
    transcriptionTask?.cancel()
    preparationTask?.cancel()
    await startingTask?.value
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
    transcriptionTask?.cancel()
    preparationTask?.cancel()
    insertion = nil
    guard phase != .idle else { return }
    phase = .processing
    let startingTask = startingTask
    let captureTask = captureTask
    let transcriptionTask = transcriptionTask
    let preparationTask = preparationTask
    Task { [weak self] in
      await startingTask?.value
      _ = await captureTask?.result
      await transcriptionTask?.value
      _ = await preparationTask?.result
      guard let self, generation == owner else { return }
      self.startingTask = nil
      self.captureTask = nil
      self.transcriptionTask = nil
      self.preparationTask = nil
      phase = storage.hasRecording ? .saved : .idle
    }
  }
}
