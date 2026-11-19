import AVKit
import SwiftUI

/// The native player owns buffering; only resolving its authorized URL precedes playback.
/// Started media claims the shared playback session, so Silent Mode cannot mute it.
struct MessageMediaPlayer: View {
  let url: URL?
  let autoplays: Bool
  let retry: () -> Void
  @State private var player: AVPlayer?
  @State private var failure: String?
  @State private var audioFailure: String?

  private static let audioUnavailable =
    "Audio is unavailable right now. End any call or recording in another app, then try again."

  private enum PlaybackEvent: Sendable {
    case status(AVPlayerItem.Status)
    case timeControl(AVPlayer.TimeControlStatus)
  }

  var body: some View {
    ZStack {
      if let failure {
        OkouEmptyState("Unable to open result", icon: "file-warning", description: Text(failure)) {
          Button("Retry", action: retry)
            .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        }
      } else {
        VStack(spacing: 0) {
          if let audioFailure {
            OkouLoadErrorRow(message: audioFailure) {
              self.audioFailure = nil
              player?.play()
            }
            .padding(.horizontal, OkouSpace.lg)
          }
          VideoPlayer(player: player)
            .overlay {
              if url == nil { ProgressView() }
            }
        }
      }
    }
    .task(id: url) { await play() }
    .onDisappear { player?.pause() }
  }

  private func play() async {
    failure = nil
    audioFailure = nil
    guard let url else { return }
    let owner = UUID()
    do {
      // Selected before the player exists, so its first output is not muted.
      try await AppAudioSession.shared.preparePlayback()
    } catch {
      audioFailure = Self.audioUnavailable
    }
    guard !Task.isCancelled else { return }
    // Signed storage receives no app credentials or shared cookies.
    let asset = AVURLAsset(url: url, options: [AVURLAssetHTTPCookiesKey: [HTTPCookie]()])
    let item = AVPlayerItem(asset: asset)
    let player = AVPlayer(playerItem: item)
    self.player = player
    let (events, continuation) = AsyncStream<PlaybackEvent>.makeStream()
    let itemStatus = item.observe(\.status, options: [.initial, .new]) { @Sendable item, _ in
      continuation.yield(.status(item.status))
    }
    let playing = player.observe(\.timeControlStatus, options: [.new]) { @Sendable player, _ in
      continuation.yield(.timeControl(player.timeControlStatus))
    }
    let failedToFinish = NotificationCenter.default.addObserver(
      forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: nil
    ) { _ in continuation.yield(.status(.failed)) }
    defer {
      itemStatus.invalidate()
      playing.invalidate()
      NotificationCenter.default.removeObserver(failedToFinish)
      continuation.finish()
      player.pause()
      player.replaceCurrentItem(with: nil)
      if self.player === player { self.player = nil }
      Task { await AppAudioSession.shared.release(owner: owner) }
    }
    if autoplays { player.play() }
    var claimed = false
    for await event in events {
      guard !Task.isCancelled else { return }
      switch event {
      case .status(.failed):
        failure = MessageArtifactStore.message(for: item.error ?? URLError(.cannotLoadFromNetwork))
        return
      case .status:
        break
      case .timeControl(.paused):
        claimed = false
      case .timeControl:
        // Native controls start playback, so claim on each start rather than only on autoplay.
        guard !claimed else { break }
        do {
          try await AppAudioSession.shared.acquire(.playback, owner: owner)
          guard !Task.isCancelled else { return }
          claimed = true
          audioFailure = nil
        } catch {
          guard !Task.isCancelled else { return }
          player.pause()
          audioFailure = Self.audioUnavailable
        }
      }
    }
  }
}
