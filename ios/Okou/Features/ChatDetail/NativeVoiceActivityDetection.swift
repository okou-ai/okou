import AVFoundation
import ChatData
import Foundation
import SoundAnalysis
import Synchronization

/// Apple's built-in classifier stays on the OS; no model or inference runtime is bundled.
/// Only confident silence across all new audio can suppress an upload.
actor NativeVoiceActivityDetection: VoiceActivityDetection {
  nonisolated let policyVersion = "sound-analysis-v1-conservative-1"

  func mayContainSpeech(_ pcm: Data) throws -> Bool {
    try Task.checkCancellation()
    guard !pcm.isEmpty, pcm.count.isMultiple(of: 2) else {
      throw DetectionError.invalidAudio
    }
    if pcm.allSatisfy({ $0 == 0 }) { return false }
    // Preserve short words and onsets without asking a one-second classifier.
    let samples = pcm.count / 2
    if samples < VoiceDraftSession.sampleRate { return true }
    let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
    let voiceLabels = [
      "speech", "whispering", "shout", "yell", "singing", "rapping", "chatter", "babble",
    ]
    guard Set(voiceLabels + ["silence"]).isSubset(of: Set(request.knownClassifications)) else {
      return true
    }
    request.windowDuration = CMTime(seconds: 1, preferredTimescale: 16_000)
    request.overlapFactor = 0.5
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("voice-analysis-\(UUID().uuidString).wav")
    defer { try? FileManager.default.removeItem(at: url) }
    try writeAudio(pcm, to: url)
    let analyzer = try SNAudioFileAnalyzer(url: url)
    defer { analyzer.removeAllRequests() }
    let observer = SilenceObserver(voiceLabels: voiceLabels)
    try analyzer.add(request, withObserver: observer)
    // Synchronous file analysis owns all callbacks until completion, off MainActor.
    analyzer.analyze()
    try Task.checkCancellation()
    return try observer.mayContainSpeech(duration: Double(samples) / 16_000)
  }

  private func writeAudio(_ pcm: Data, to url: URL) throws {
    guard let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1),
      let buffer = AVAudioPCMBuffer(
        pcmFormat: format, frameCapacity: AVAudioFrameCount(pcm.count / 2)),
      let channel = buffer.floatChannelData?[0]
    else { throw DetectionError.invalidAudio }
    buffer.frameLength = buffer.frameCapacity
    pcm.withUnsafeBytes { bytes in
      for sample in 0..<Int(buffer.frameLength) {
        channel[sample] =
          Float(
            Int16(littleEndian: bytes.loadUnaligned(fromByteOffset: sample * 2, as: Int16.self)))
          / 32_768
      }
    }
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    try file.write(from: buffer)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
      ofItemAtPath: url.path)
  }

  private enum DetectionError: Error {
    case invalidAudio, invalidResult
  }

  private final class SilenceObserver: NSObject, SNResultsObserving, Sendable {
    private struct State: Sendable {
      var coveredUntil: Double = 0
      var uncertain = false
      var completed = false
      var failure: (any Error)?
    }
    private let state = Mutex(State())
    private let voiceLabels: [String]

    init(voiceLabels: [String]) { self.voiceLabels = voiceLabels }

    func request(_ request: any SNRequest, didProduce result: any SNResult) {
      state.withLock { state in
        guard let result = result as? SNClassificationResult,
          let silence = result.classification(forIdentifier: "silence"),
          silence.confidence.isFinite,
          voiceLabels.allSatisfy({ label in
            guard let voice = result.classification(forIdentifier: label) else { return false }
            return voice.confidence.isFinite && voice.confidence <= 0.01
          }), silence.confidence >= 0.95
        else {
          state.uncertain = true
          return
        }
        let start = result.timeRange.start.seconds
        let end = CMTimeRangeGetEnd(result.timeRange).seconds
        guard start.isFinite, end.isFinite, start <= state.coveredUntil + 1.0 / 16_000,
          end > start
        else {
          state.uncertain = true
          return
        }
        state.coveredUntil = max(state.coveredUntil, end)
      }
    }

    func request(_ request: any SNRequest, didFailWithError error: any Error) {
      state.withLock { $0.failure = error }
    }

    func requestDidComplete(_ request: any SNRequest) {
      state.withLock { $0.completed = true }
    }

    func mayContainSpeech(duration: Double) throws -> Bool {
      try state.withLock { state in
        if let failure = state.failure { throw failure }
        guard state.completed else { throw DetectionError.invalidResult }
        return state.uncertain || state.coveredUntil + 1.0 / 16_000 < duration
      }
    }
  }
}
