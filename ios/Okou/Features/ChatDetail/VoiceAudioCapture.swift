import AVFoundation
import ChatData
import Foundation
import Synchronization

struct VoiceAudioChunk: Sendable {
  let pcm: Data
  let level: Float
}

@MainActor
protocol VoiceAudioCapture: AnyObject {
  func start() async throws -> AsyncThrowingStream<VoiceAudioChunk, Error>
  func stop()
}

@MainActor
final class NativeVoiceAudioCapture: VoiceAudioCapture {
  private var sessionOwner: UUID?
  private var engine: AVAudioEngine?
  private var encoder: VoicePCMEncoder?
  private var continuation: AsyncThrowingStream<VoiceAudioChunk, Error>.Continuation?
  private var observers: [NSObjectProtocol] = []

  func start() async throws -> AsyncThrowingStream<VoiceAudioChunk, Error> {
    guard await AVAudioApplication.requestRecordPermission() else {
      throw CaptureError.permissionDenied
    }
    try Task.checkCancellation()
    let owner = UUID()
    try await VoiceRecordingAudioSession.shared.activate(owner: owner)
    do {
      try Task.checkCancellation()
      let audio = AVAudioSession.sharedInstance()
      let engine = AVAudioEngine()
      let input = engine.inputNode
      let encoder = try VoicePCMEncoder(format: input.outputFormat(forBus: 0))
      let (stream, continuation) = AsyncThrowingStream<VoiceAudioChunk, Error>.makeStream()
      input.installTap(onBus: 0, bufferSize: 4_096, format: nil) { @Sendable buffer, _ in
        do {
          let chunk = try encoder.convert(buffer)
          if !chunk.pcm.isEmpty { continuation.yield(chunk) }
        } catch { continuation.finish(throwing: error) }
      }
      self.engine = engine
      sessionOwner = owner
      self.encoder = encoder
      self.continuation = continuation
      engine.prepare()
      try engine.start()
      observers = [
        NotificationCenter.default.addObserver(
          forName: AVAudioSession.interruptionNotification, object: audio, queue: .main
        ) { [weak self] notification in
          guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .began
          else { return }
          Task { @MainActor [weak self] in
            guard self?.sessionOwner == owner else { return }
            self?.stop()
          }
        },
        NotificationCenter.default.addObserver(
          forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
        ) { [weak self] _ in
          Task { @MainActor [weak self] in
            guard self?.sessionOwner == owner else { return }
            self?.stop()
          }
        },
      ]
      return stream
    } catch {
      stop()
      await VoiceRecordingAudioSession.shared.deactivate(owner: owner)
      throw error
    }
  }

  func stop() {
    guard let engine else { return }
    self.engine = nil
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    do {
      if let chunk = try encoder?.convert(nil), !chunk.pcm.isEmpty {
        continuation?.yield(chunk)
      }
      continuation?.finish()
    } catch { continuation?.finish(throwing: error) }
    continuation = nil
    encoder = nil
    if let owner = sessionOwner {
      sessionOwner = nil
      Task { await VoiceRecordingAudioSession.shared.deactivate(owner: owner) }
    }
  }

  enum CaptureError: LocalizedError {
    case permissionDenied, unsupportedFormat
    var errorDescription: String? {
      switch self {
      case .permissionDenied: "Allow microphone access in Settings to use voice input."
      case .unsupportedFormat: "This microphone's audio format is unavailable. Try another input."
      }
    }
  }
}

/// System audio activation can block. Its process-wide owner serializes work off
/// the UI actor and prevents a retired recording from deactivating a new one.
private actor VoiceRecordingAudioSession {
  static let shared = VoiceRecordingAudioSession()
  private var owner: UUID?

  func activate(owner: UUID) throws {
    let audio = AVAudioSession.sharedInstance()
    try audio.setCategory(
      .playAndRecord, mode: .measurement, options: [.defaultToSpeaker, .allowBluetoothHFP])
    try audio.setActive(true)
    self.owner = owner
  }

  func deactivate(owner: UUID) {
    guard self.owner == owner else { return }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    self.owner = nil
  }
}

/// The audio callback and stop/drain can arrive on different threads. The lock
/// gives the converter one owner and ensures the final buffered samples are saved.
final class VoicePCMEncoder: Sendable {
  private struct Conversion {
    let converter: AVAudioConverter
    let format: AVAudioFormat
  }
  private let conversion: Mutex<Conversion>

  init(format: AVAudioFormat) throws {
    guard format.sampleRate > 0, format.channelCount > 0,
      let output = AVAudioFormat(
        commonFormat: .pcmFormatInt16, sampleRate: Double(VoiceDraftSession.sampleRate),
        channels: 1, interleaved: true),
      let converter = AVAudioConverter(from: format, to: output)
    else { throw NativeVoiceAudioCapture.CaptureError.unsupportedFormat }
    conversion = Mutex(Conversion(converter: converter, format: output))
  }

  func convert(_ input: AVAudioPCMBuffer?) throws -> VoiceAudioChunk {
    try conversion.withLock { conversion in
      var result = Data()
      var supplied = false
      var status = AVAudioConverterOutputStatus.haveData
      while status == .haveData {
        guard let output = AVAudioPCMBuffer(pcmFormat: conversion.format, frameCapacity: 4_096)
        else { throw NativeVoiceAudioCapture.CaptureError.unsupportedFormat }
        var error: NSError?
        status = conversion.converter.convert(to: output, error: &error) { _, state in
          if let input, !supplied {
            supplied = true
            state.pointee = .haveData
            return input
          }
          state.pointee = input == nil ? .endOfStream : .noDataNow
          return nil
        }
        if let error { throw error }
        if status == .error { throw NativeVoiceAudioCapture.CaptureError.unsupportedFormat }
        if let samples = output.int16ChannelData?.pointee {
          result.append(Data(bytes: samples, count: Int(output.frameLength) * 2))
        }
      }
      let energy = result.withUnsafeBytes { bytes -> Float in
        let samples = bytes.bindMemory(to: Int16.self)
        guard !samples.isEmpty else { return 0 }
        let sum = samples.reduce(Float(0)) { sum, value in
          let normalized = Float(value) / 32_768
          return sum + normalized * normalized
        }
        return min(1, sqrt(sum / Float(samples.count)) * 5)
      }
      return VoiceAudioChunk(pcm: result, level: energy)
    }
  }
}
