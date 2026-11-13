import AVKit
import SwiftUI

/// The native player owns buffering; only resolving its authorized URL precedes playback.
struct MessageMediaPlayer: View {
  let url: URL?
  let autoplays: Bool
  let retry: () -> Void
  @State private var player: AVPlayer?
  @State private var failure: String?

  var body: some View {
    Group {
      if let failure {
        OkouEmptyState("Unable to open result", icon: "file-warning", description: Text(failure)) {
          Button("Retry", action: retry)
            .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
        }
      } else {
        VideoPlayer(player: player)
          .overlay {
            if url == nil { ProgressView() }
          }
      }
    }
    .task(id: url) { await play() }
    .onDisappear { player?.pause() }
  }

  private func play() async {
    failure = nil
    guard let url else { return }
    // Signed storage receives no app credentials or shared cookies.
    let asset = AVURLAsset(url: url, options: [AVURLAssetHTTPCookiesKey: [HTTPCookie]()])
    let item = AVPlayerItem(asset: asset)
    let player = AVPlayer(playerItem: item)
    self.player = player
    let (statuses, continuation) = AsyncStream<AVPlayerItem.Status>.makeStream(
      bufferingPolicy: .bufferingNewest(1))
    let observation = item.observe(\.status, options: [.initial, .new]) { item, _ in
      continuation.yield(item.status)
    }
    let failedToFinish = NotificationCenter.default.addObserver(
      forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: nil
    ) { _ in continuation.yield(.failed) }
    defer {
      observation.invalidate()
      NotificationCenter.default.removeObserver(failedToFinish)
      continuation.finish()
      player.pause()
      player.replaceCurrentItem(with: nil)
      if self.player === player { self.player = nil }
    }
    if autoplays { player.play() }
    for await status in statuses {
      guard !Task.isCancelled else { return }
      if status == .failed {
        failure = MessageArtifactStore.message(for: item.error ?? URLError(.cannotLoadFromNetwork))
        return
      }
    }
  }
}
