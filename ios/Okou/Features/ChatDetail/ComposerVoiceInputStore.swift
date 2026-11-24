import CCState
import ChatData
import Foundation

/// Capture, transcription and insertion belong to one draft, including while its view unmounts.
/// Its presented state lives in the owning composer's graph.
@MainActor
final class ComposerVoiceInputStore {
  enum Phase: Equatable { case idle, starting, recording, processing, saved }

  /// What the voice controls read.
  struct Content: Equatable {
    var phase = Phase.idle
    var duration: Double = 0
    var levels: [Float] = []
    var error: String?
    var microphoneDenied = false
    var asVoiceMessage = false
    var recordingID: UUID?
    var hasSession = false

    var isWorking: Bool { phase == .starting || phase == .recording || phase == .processing }
    var canUseRecording: Bool { hasSession && recordingID != nil }
  }

  private(set) var phase: Phase {
    get { snapshot.phase }
    set { update { $0.phase = newValue } }
  }
  private(set) var duration: Double {
    get { snapshot.duration }
    set { update { $0.duration = newValue } }
  }
  private(set) var levels: [Float] {
    get { snapshot.levels }
    set { update { $0.levels = newValue } }
  }
  private(set) var error: String? {
    get { snapshot.error }
    set { update { $0.error = newValue } }
  }
  private(set) var microphoneDenied: Bool {
    get { snapshot.microphoneDenied }
    set { update { $0.microphoneDenied = newValue } }
  }
  var isWorking: Bool { snapshot.isWorking }
  var canUseRecording: Bool { snapshot.canUseRecording }
  weak var composer: ComposerDraftStore?
  private let store: CCState.Store
  private let content: CCState.State<Content>
  /// The full voice state, for the recording tray.
  let value: Computed<Content>
  /// Only the phase, for readers that must not refresh with every audio level.
  let phaseValue: Computed<Phase>
  /// The phase of a composer without voice input.
  static let idlePhase = Computed { _ in Phase.idle }
  private let client: VoiceInputClient
  private let storage: VoiceDraftStorage
  private let capture: any VoiceAudioCapture
  private let didRequireUpgrade: @MainActor (Error) -> Void
  private var session: VoiceDraftSession?
  private var recordingID: UUID? {
    get { snapshot.recordingID }
    set { update { $0.recordingID = newValue } }
  }
  private var insertion: ComposerEditor.VoiceInsertion?
  private var generation = UUID()
  private var startingTask: Task<Void, Never>?
  private var quotaTask: Task<Void, Error>?
  private(set) var asVoiceMessage: Bool {
    get { snapshot.asVoiceMessage }
    set { update { $0.asVoiceMessage = newValue } }
  }
  private var quotaAllowed = false
  private var captureTask: Task<Void, Error>?
  private var transcriptionTask: Task<Void, Never>?
  private var preparationTask: Task<String, Error>?
  private var transcriptionFailed = false
  private var startRequested = false

  init(
    client: VoiceInputClient, storage: VoiceDraftStorage,
    capture: any VoiceAudioCapture = NativeVoiceAudioCapture(),
    store: CCState.Store,
    didRequireUpgrade: @escaping @MainActor (Error) -> Void
  ) {
    self.client = client
    self.storage = storage
    self.capture = capture
    self.didRequireUpgrade = didRequireUpgrade
    self.store = store
    let content = CCState.State(Content())
    self.content = content
    value = Computed { get in try get(content) }
    phaseValue = Computed { get in try get(content).phase }
    restore()
  }

  var snapshot: Content {
    do { return try store.get(content) } catch {
      preconditionFailure("Cannot read the voice input graph: \(error)")
    }
  }

  private func update(_ mutation: (inout Content) -> Void) {
    do {
      try store.set(
        content,
        update: { previous in
          var next = previous
          mutation(&next)
          return next
        })
    } catch { preconditionFailure("Cannot update the voice input graph: \(error)") }
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
      update { $0.hasSession = true }
      recordingID = session.restoredRecordingID
      asVoiceMessage = session.restoredAsVoiceMessage
      duration = session.restoredDuration
      phase = storage.hasRecording ? .saved : .idle
    } catch {
      phase = .saved
      self.error = "Cannot restore this recording. " + error.localizedDescription
    }
  }

  func start() async {
    startRequested = false
    await beginStart()?.value
  }

  /// A system entry may arrive before the new draft's native editor is mounted.
  func requestStart() {
    startRequested = true
    startRequestedInputIfReady()
  }

  func startRequestedInputIfReady() {
    guard startRequested else { return }
    guard phase == .idle, let composer, composer.canEditVoice else {
      startRequested = false
      return
    }
    guard composer.editor.voiceInsertion() != nil else { return }
    startRequested = false
    _ = beginStart()
  }

  private func beginStart() -> Task<Void, Never>? {
    guard phase == .idle, startingTask == nil, let composer, composer.canEditVoice else {
      return nil
    }
    guard let target = composer.editor.voiceInsertion() else {
      error = "Finish editing before starting voice input."
      return nil
    }
    let owner = UUID()
    generation = owner
    phase = .starting
    quotaAllowed = false
    error = nil
    microphoneDenied = false
    let starting = Task {
      await begin(composer: composer, target: target, owner: owner)
      if generation == owner { startingTask = nil }
    }
    startingTask = starting
    return starting
  }

  private func begin(
    composer: ComposerDraftStore, target: ComposerEditor.VoiceInsertion, owner: UUID
  ) async {
    guard generation == owner, !Task.isCancelled, composer.canEditVoice else {
      if generation == owner { phase = .idle }
      return
    }
    do {
      let asMessage = try await client.recordAsMessage()
      guard generation == owner, !Task.isCancelled, composer.canEditVoice else {
        if generation == owner { phase = .idle }
        return
      }
      asVoiceMessage = asMessage
      quotaTask = asMessage ? nil : checkQuota()
      let stream = try await capture.start()
      guard generation == owner, composer.canEditVoice else {
        quotaTask?.cancel()
        capture.stop()
        if generation == owner { phase = .idle }
        return
      }
      guard let session else { throw VoiceDraftError.unavailable }
      let id = try await session.begin(context: target.context, asVoiceMessage: asVoiceMessage)
      recordingID = id
      insertion = target
      duration = 0
      levels = []
      transcriptionFailed = false
      captureTask?.cancel()
      captureTask = captureStream(stream, session: session, id: id, owner: owner)
      if generation == owner {
        phase = .recording
        composer.editor.dismissMentions()
        composer.editor.workflows.dismiss()
      } else {
        quotaTask?.cancel()
        capture.stop()
        if phase == .idle { phase = .saved }
      }
    } catch {
      quotaTask?.cancel()
      guard generation == owner else { return }
      capture.stop()
      phase = storage.hasRecording ? .saved : .idle
      report(error)
      if case NativeVoiceAudioCapture.CaptureError.permissionDenied = error {
        microphoneDenied = true
      }
      return
    }
    guard let quota = quotaTask else { return }
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

  /// Returns the original stream Task to the draft owner for cancellation and draining.
  private func captureStream(
    _ stream: AsyncThrowingStream<VoiceAudioChunk, Error>, session: VoiceDraftSession,
    id: UUID, owner: UUID
  ) -> Task<Void, Error> {
    return Task { [weak self] in
      do {
        for try await chunk in stream {
          let duration = try await session.append(chunk.pcm, recordingID: id)
          // Suspension drains the final audio; only a cancelled capture stops publishing.
          guard let self, !Task.isCancelled else { return }
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
    guard !asVoiceMessage, quotaAllowed, transcriptionTask == nil, !transcriptionFailed, let session
    else { return }
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

  private func insertUploadedRecording(
    _ fileID: String, session: VoiceDraftSession, id: UUID, composer: ComposerDraftStore,
    owner: UUID
  ) async throws {
    guard generation == owner, composer.canEditVoice else { return }
    composer.appendVoiceClip(fileID, recordingID: id)
    guard !composer.hasLocalFailure else {
      error = "Save the draft on this device before discarding the recording."
      return
    }
    try await session.discard()
    guard generation == owner else { return }
    recordingID = nil
    insertion = nil
    phase = .idle
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
      if asVoiceMessage {
        guard generation == owner, composer.canEditVoice else { return }
        let upload = Task { try await session.uploadClip(recordingID: id) }
        preparationTask = upload
        try await insertUploadedRecording(
          upload.value, session: session, id: id, composer: composer, owner: owner)
        return
      }
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
    startRequested = false
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
    startingTask = nil
    quotaTask = nil
    captureTask = nil
    transcriptionTask = nil
    preparationTask = nil
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

  @discardableResult
  func suspend() -> Task<Void, Never> {
    startRequested = false
    generation = UUID()
    let owner = generation
    capture.stop()
    startingTask?.cancel()
    quotaTask?.cancel()
    transcriptionTask?.cancel()
    preparationTask?.cancel()
    insertion = nil
    let captureTask = captureTask
    guard phase != .idle else { return Task { _ = await captureTask?.result } }
    phase = .processing
    let startingTask = startingTask
    let quotaTask = quotaTask
    let transcriptionTask = transcriptionTask
    let preparationTask = preparationTask
    return Task { [weak self] in
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
