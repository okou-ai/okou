import AVFoundation
import ChatData
import Observation
import Synchronization

/// Dictation that matches the web's voice drafts: 16 kHz mono speech is uploaded in 15 s
/// segments (2 s overlap) while recording, then the segment transcripts are polished into
/// one send-ready text. The server owns transcription quality, languages and the daily quota.
@MainActor @Observable
final class VoiceInputStore {
  enum Phase: Equatable { case idle, recording, transcribing }

  static let maximumDuration: TimeInterval = 600
  static let levelInterval = OkouMotion.waveformSample
  private static let keptLevels = 120
  private static let segmentSamples = 15 * ChatVoiceWAV.sampleRate
  private static let overlapSamples = 2 * ChatVoiceWAV.sampleRate
  private static let minimumSamples = ChatVoiceWAV.sampleRate / 3

  private(set) var phase: Phase = .idle
  private(set) var elapsed: TimeInterval = 0
  /// Loudness for the waveform, 0 to 1 on a decibel scale, oldest first, one per
  /// `levelInterval`.
  private(set) var levels: [Float] = []
  /// When the newest level arrived, so the waveform can scroll between samples.
  private(set) var lastLevelAt = Date.now
  private(set) var reachedLimit = false
  var error: String?

  private let client: APIClient
  private let engine = AVAudioEngine()
  private let capture = VoiceCapture()
  private var session = UUID()
  private var startedAt = Date.now
  private var nextSegmentStart = 0
  private var segmentCount = 0
  private var transcripts: [String] = []
  private var uploadFailure: Error?
  private var uploads: Task<Void, Never>?
  private var meter: Task<Void, Never>?

  init(client: APIClient) { self.client = client }

  var isActive: Bool { phase != .idle }

  func start() async {
    guard phase == .idle else { return }
    error = nil
    guard await AVAudioApplication.requestRecordPermission() else {
      error = String(localized: "Allow microphone access in Settings to dictate.")
      return
    }
    if let quota = try? await client.voiceQuota(), !quota.allowed {
      error = String(localized: "You've reached today's voice input limit.")
      return
    }
    guard phase == .idle else { return }
    do {
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.record, mode: .default)
      try audio.setActive(true, options: .notifyOthersOnDeactivation)
      let input = engine.inputNode
      let format = input.outputFormat(forBus: 0)
      try capture.prepare(from: format)
      input.installTap(
        onBus: 0, bufferSize: 4096, format: format, block: Self.tap(writingTo: capture))
      engine.prepare()
      try engine.start()
    } catch {
      stopCapture()
      self.error = String(localized: "Couldn't start recording. Try again.")
      return
    }
    session = UUID()
    startedAt = .now
    elapsed = 0
    levels = []
    reachedLimit = false
    nextSegmentStart = 0
    segmentCount = 0
    transcripts = []
    uploadFailure = nil
    phase = .recording
    let id = session
    meter = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(Self.levelInterval))
        guard let self, self.session == id, self.phase == .recording else { return }
        self.tick()
      }
    }
  }

  /// Stops recording and returns the polished transcript, or nil with `error` set.
  func finish() async -> String? {
    guard phase == .recording else { return nil }
    let id = session
    stopCapture()
    phase = .transcribing
    let count = capture.count
    let tail = count - nextSegmentStart - (segmentCount == 0 ? 0 : Self.overlapSamples)
    if tail > Self.minimumSamples {
      enqueueSegment(from: nextSegmentStart, to: count)
    }
    await uploads?.value
    guard session == id else { return nil }
    defer { if session == id { reset() } }
    if let uploadFailure {
      error = message(for: uploadFailure)
      return nil
    }
    guard !transcripts.isEmpty else {
      error = String(localized: "No speech detected.")
      return nil
    }
    let polished = try? await client.polishVoiceSegments(transcripts)
    guard session == id else { return nil }
    if let polished, !polished.isEmpty { return polished }
    return transcripts.joined(separator: " ")
  }

  func cancel() {
    guard phase != .idle else { return }
    stopCapture()
    reset()
  }

  private func tick() {
    elapsed = Date.now.timeIntervalSince(startedAt)
    levels.append(Self.loudness(capture.takeLevel(), previous: levels.last ?? 0))
    lastLevelAt = .now
    if levels.count > Self.keptLevels { levels.removeFirst(levels.count - Self.keptLevels) }
    // Each full segment is transcribed while the speaker keeps talking.
    while capture.count >= nextSegmentStart + Self.segmentSamples {
      enqueueSegment(from: nextSegmentStart, to: nextSegmentStart + Self.segmentSamples)
    }
    if elapsed >= Self.maximumDuration && !reachedLimit {
      reachedLimit = true
      stopCapture()
    }
  }

  /// A peak sample as the ear hears it: -45 dBFS (room noise) is 0, -8 dBFS (close, loud
  /// speech) is 1. A short release keeps one syllable from flickering bar to bar.
  private static func loudness(_ peak: Float, previous: Float) -> Float {
    let decibels = 20 * log10(max(peak, 0.000_01))
    let level = min(max((decibels + 45) / 37, 0), 1)
    return max(level, previous * 0.45)
  }

  private func enqueueSegment(from start: Int, to end: Int) {
    let samples = capture.samples(from: start, to: end)
    let overlap =
      segmentCount == 0 ? 0 : Double(Self.overlapSamples) / Double(ChatVoiceWAV.sampleRate)
    let total = Double(end) / Double(ChatVoiceWAV.sampleRate)
    segmentCount += 1
    nextSegmentStart = start + Self.segmentSamples - Self.overlapSamples
    // Like the web, silent segments never leave the device: no request, no quota.
    guard Self.containsSpeech(samples) else { return }
    let id = session
    let previous = uploads
    let client = client
    uploads = Task { [weak self] in
      await previous?.value
      guard let self, self.session == id, self.uploadFailure == nil else { return }
      do {
        let text = try await client.transcribeVoiceSegment(
          wav: ChatVoiceWAV.encode(samples),
          previousTranscript: self.transcripts.joined(separator: " "),
          overlapSeconds: overlap, totalSeconds: total)
        guard self.session == id else { return }
        if let text { self.transcripts.append(text) }
      } catch {
        guard self.session == id else { return }
        self.uploadFailure = error
      }
    }
  }

  /// A coarse voice-activity check: any 100 ms window louder than about -45 dBFS RMS.
  nonisolated static func containsSpeech(_ samples: [Int16]) -> Bool {
    let window = ChatVoiceWAV.sampleRate / 10
    var index = 0
    while index < samples.count {
      let end = min(samples.count, index + window)
      var sum: Double = 0
      for sample in samples[index..<end] {
        let value = Double(sample) / Double(Int16.max)
        sum += value * value
      }
      if (sum / Double(max(1, end - index))).squareRoot() > 0.0056 { return true }
      index = end
    }
    return false
  }

  private func message(for failure: Error) -> String {
    switch (failure as? APIClientError)?.statusCode {
    case 402: String(localized: "Voice input isn't included in this workspace's plan.")
    case 429: String(localized: "You've reached today's voice input limit.")
    case 503: String(localized: "Voice input is unavailable right now. Try again later.")
    default: String(localized: "Couldn't transcribe the recording. Try again.")
    }
  }

  private func stopCapture() {
    meter?.cancel()
    if engine.isRunning { engine.stop() }
    engine.inputNode.removeTap(onBus: 0)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func reset() {
    session = UUID()
    uploads?.cancel()
    uploads = nil
    meter = nil
    phase = .idle
    elapsed = 0
    levels = []
    reachedLimit = false
    transcripts = []
    uploadFailure = nil
    capture.reset()
  }

  /// Formed outside the main actor: the engine calls it on its realtime audio thread.
  nonisolated private static func tap(writingTo capture: VoiceCapture) -> AVAudioNodeTapBlock {
    { buffer, _ in capture.append(buffer) }
  }
}

/// Converts engine buffers to 16 kHz mono Int16 and keeps them for segment uploads.
final class VoiceCapture: @unchecked Sendable {
  private struct Samples {
    var values: [Int16] = []
    var peak: Float = 0
  }

  private let samples = Mutex(Samples())
  // Set before the tap is installed and then used only on the audio thread.
  private var converter: AVAudioConverter?
  private let target = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: Double(ChatVoiceWAV.sampleRate), channels: 1,
    interleaved: true)!

  func prepare(from format: AVAudioFormat) throws {
    guard let converter = AVAudioConverter(from: format, to: target) else {
      throw CocoaError(.featureUnsupported)
    }
    self.converter = converter
    reset()
  }

  var count: Int { samples.withLock { $0.values.count } }

  func samples(from start: Int, to end: Int) -> [Int16] {
    samples.withLock { state in
      let lower = max(0, min(start, state.values.count))
      let upper = max(lower, min(end, state.values.count))
      return Array(state.values[lower..<upper])
    }
  }

  func takeLevel() -> Float {
    samples.withLock { state in
      let level = state.peak
      state.peak = 0
      return level
    }
  }

  func reset() { samples.withLock { $0 = Samples() } }

  func append(_ buffer: AVAudioPCMBuffer) {
    guard let converter, buffer.frameLength > 0 else { return }
    let ratio = target.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return }
    var supplied = false
    var conversionError: NSError?
    converter.convert(to: output, error: &conversionError) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    guard conversionError == nil, let channel = output.int16ChannelData?[0] else { return }
    let frames = Int(output.frameLength)
    var chunk = [Int16](repeating: 0, count: frames)
    var peak: Float = 0
    for index in 0..<frames {
      let sample = channel[index]
      chunk[index] = sample
      peak = max(peak, abs(Float(sample)) / Float(Int16.max))
    }
    samples.withLock { state in
      state.values.append(contentsOf: chunk)
      state.peak = max(state.peak, min(1, peak))
    }
  }
}
