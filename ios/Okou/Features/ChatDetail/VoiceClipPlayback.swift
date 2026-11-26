import AVFoundation
import ChatData
import ChatDomain
import Foundation

/// The composer and its transcript share one queue and the same scoped attachment resolver.
@MainActor
final class VoiceClipPlayback {
  private let artifacts: ChatArtifacts
  private weak var clip: VoiceClipControl?
  private var player: AVQueuePlayer?
  private var operation: Task<Void, Never>?
  private var owner: UUID?
  private var timeObserver: Any?
  private var endObservers: [NSObjectProtocol] = []
  private var itemObservers: [NSKeyValueObservation] = []
  private var offsets: [ObjectIdentifier: TimeInterval] = [:]
  private var elapsed: TimeInterval = 0

  init(artifacts: ChatArtifacts) {
    self.artifacts = artifacts
  }

  func owns(_ control: VoiceClipControl) -> Bool { clip === control }

  func duration(_ ids: [String]) async -> TimeInterval? {
    var total: TimeInterval = 0
    for id in ids {
      guard !Task.isCancelled, let source = try? await asset(for: id),
        let seconds = await Self.duration(of: source)
      else { return nil }
      total += seconds
    }
    return total
  }

  func detach(_ control: VoiceClipControl) {
    if owns(control) { stop() }
  }

  func toggle(_ control: VoiceClipControl) {
    if owns(control), let player, owner != nil {
      player.pause()
      releaseAudio()
      control.render(.paused, elapsed: elapsed)
      return
    }
    if !owns(control) {
      stop()
      clip = control
    }
    guard operation == nil else {
      stop()
      return
    }
    control.render(.loading)
    operation = Task { [weak self, weak control] in
      guard let self, let control else { return }
      await self.start(control)
    }
  }

  private func start(_ control: VoiceClipControl) async {
    let claim = UUID()
    do {
      let player: AVQueuePlayer
      if let prepared = self.player {
        player = prepared
      } else {
        player = try await prepare(control)
      }
      try Task.checkCancellation()
      try await AppAudioSession.shared.acquire(.playback, owner: claim)
      guard !Task.isCancelled, owns(control) else {
        await AppAudioSession.shared.release(owner: claim)
        return
      }
      owner = claim
      operation = nil
      player.play()
      control.render(.playing, elapsed: elapsed)
    } catch {
      guard !Task.isCancelled, owns(control) else { return }
      fail()
    }
  }

  private func prepare(_ control: VoiceClipControl) async throws -> AVQueuePlayer {
    var items: [AVPlayerItem] = []
    var offsets: [ObjectIdentifier: TimeInterval] = [:]
    var total: TimeInterval = 0
    var completeDuration = true
    for id in control.fileIDs {
      try Task.checkCancellation()
      let asset = try await asset(for: id)
      let item = AVPlayerItem(asset: asset)
      offsets[ObjectIdentifier(item)] = total
      if let seconds = await Self.duration(of: asset) {
        total += seconds
      } else {
        completeDuration = false
      }
      items.append(item)
    }
    try Task.checkCancellation()
    guard !items.isEmpty else { throw URLError(.resourceUnavailable) }
    if completeDuration { control.duration = total }
    let player = AVQueuePlayer(items: items)
    self.player = player
    self.offsets = offsets
    observe(player, items: items)
    return player
  }

  private func observe(_ player: AVQueuePlayer, items: [AVPlayerItem]) {
    timeObserver = player.addPeriodicTimeObserver(
      forInterval: CMTime(value: 1, timescale: 8), queue: .main
    ) { [weak self, weak player] time in
      MainActor.assumeIsolated {
        if let player, self?.player === player { self?.updateElapsed(time.seconds) }
      }
    }
    endObservers = [
      NotificationCenter.default.addObserver(
        forName: AVPlayerItem.didPlayToEndTimeNotification, object: items.last, queue: .main
      ) { [weak self, weak player] _ in
        MainActor.assumeIsolated {
          if let player, self?.player === player { self?.stop() }
        }
      }
    ]
    itemObservers = items.map { item in
      item.observe(\.status, options: [.initial, .new]) { [weak self, weak player] item, _ in
        guard item.status == .failed else { return }
        Task { @MainActor in
          if let player, self?.player === player { self?.fail() }
        }
      }
    }
  }

  private func updateElapsed(_ seconds: TimeInterval) {
    guard owner != nil, let item = player?.currentItem, seconds.isFinite, seconds >= 0 else {
      return
    }
    elapsed = (offsets[ObjectIdentifier(item)] ?? 0) + seconds
    clip?.render(.playing, elapsed: elapsed)
  }

  private func asset(for id: String) async throws -> AVURLAsset {
    let attachment = ChatArtifact(
      source: .file(id), filename: "Voice recording", contentType: "audio/*", size: nil)
    let resolved = try await artifacts.resolve(attachment)
    return AVURLAsset(url: resolved.contentURL, options: [AVURLAssetHTTPCookiesKey: [HTTPCookie]()])
  }

  private static func duration(of asset: AVURLAsset) async -> TimeInterval? {
    guard let seconds = try? await asset.load(.duration).seconds,
      seconds.isFinite, seconds > 0, seconds < Double(Int32.max)
    else { return nil }
    return seconds
  }

  private func releaseAudio() {
    guard let owner else { return }
    self.owner = nil
    Task { await AppAudioSession.shared.release(owner: owner) }
  }

  private func fail() {
    let failed = clip
    stop()
    failed?.render(.failed)
  }

  func stop() {
    operation?.cancel()
    operation = nil
    player?.pause()
    if let timeObserver { player?.removeTimeObserver(timeObserver) }
    timeObserver = nil
    for observer in endObservers { NotificationCenter.default.removeObserver(observer) }
    endObservers = []
    for observer in itemObservers { observer.invalidate() }
    itemObservers = []
    player?.removeAllItems()
    player = nil
    offsets = [:]
    elapsed = 0
    clip?.render()
    clip = nil
    releaseAudio()
  }
}
