import SwiftUI
import UIKit

/// TextKit owns the clip's position and selection as one document character. The overlay
/// control owns only its native rendering and forwards playback to the containing composer.
final class ComposerVoiceClipControl: UIControl {
  static let visualHeight: CGFloat = 28
  private static let barHeights: [CGFloat] = [4, 7, 12, 9, 5, 13, 16]
  private let glyph = UIImageView()
  private let chip = UIView()
  private let time = UILabel()
  private let bars = ComposerVoiceClipControl.barHeights.map { _ in UIView() }
  let fileIDs: [String]
  private weak var editor: ComposerTextView?
  private var metadata: Task<Void, Never>?
  var duration: TimeInterval?
  private var progress = 0.0

  nonisolated static func preferredWidth(font: UIFont) -> CGFloat {
    max(104, ceil(font.pointSize * 6))
  }

  init(fileIDs: [String], editor: ComposerTextView, fontSize: CGFloat) {
    self.fileIDs = fileIDs
    self.editor = editor
    super.init(frame: .zero)
    isAccessibilityElement = true
    accessibilityTraits = .button
    accessibilityIdentifier = "composer-voice-clip"
    chip.layer.cornerRadius = OkouRadius.small
    chip.isUserInteractionEnabled = false
    addSubview(chip)
    chip.addSubview(glyph)
    for bar in bars { chip.addSubview(bar) }
    time.font = UIFont.monospacedDigitSystemFont(
      ofSize: max(12, fontSize * 0.71), weight: .regular)
    time.textAlignment = .right
    time.adjustsFontSizeToFitWidth = true
    time.minimumScaleFactor = 0.75
    chip.addSubview(time)
    addAction(UIAction { [weak self] _ in self?.toggle() }, for: .touchUpInside)
    render()
    registerForTraitChanges([UITraitUserInterfaceStyle.self], action: #selector(updateColors))
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet { updateColors() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      metadata?.cancel()
      metadata = nil
      editor?.voicePlayback?.detach(self)
      return
    }

    guard let playback = editor?.voicePlayback, duration == nil, metadata == nil else { return }
    metadata = Task { [weak self, weak playback] in
      guard let playback, let fileIDs = self?.fileIDs else { return }
      let duration = await playback.duration(fileIDs)
      guard !Task.isCancelled, let self else { return }
      self.metadata = nil
      self.duration = duration
      if !playback.owns(self) { self.render() }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let height = min(bounds.height, Self.visualHeight)
    let width = max(0, bounds.width - OkouSpace.xs)
    chip.frame = CGRect(x: 0, y: (bounds.height - height) / 2, width: width, height: height)
    glyph.frame = CGRect(x: OkouSpace.xs, y: (height - 20) / 2, width: 20, height: 20)
    let timeWidth = min(max(38, width * 0.39), max(0, width - 32))
    time.frame = CGRect(
      x: width - timeWidth - OkouSpace.sm, y: 0, width: timeWidth, height: height)
    let room = max(0, time.frame.minX - glyph.frame.maxX - 2 * OkouSpace.xs)
    for (index, bar) in bars.enumerated() {
      let barHeight = Self.barHeights[index]
      bar.isHidden = CGFloat(index * 4 + 2) > room
      bar.frame = CGRect(
        x: glyph.frame.maxX + OkouSpace.xs + CGFloat(index * 4),
        y: (height - barHeight) / 2, width: 2, height: barHeight)
      bar.layer.cornerRadius = 1
    }
  }

  override func accessibilityActivate() -> Bool {
    toggle()
  }

  func updateFontSize(_ fontSize: CGFloat) {
    let size = max(12, fontSize * 0.71)
    if time.font?.pointSize != size {
      time.font = UIFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)
    }
  }

  @discardableResult private func toggle() -> Bool {
    guard editor?.isCurrent() == true, let playback = editor?.voicePlayback else { return false }
    playback.toggle(self)
    return true
  }

  enum PlaybackState {
    case ready, loading, playing, paused, failed
  }

  func render(_ state: PlaybackState = .ready, elapsed: TimeInterval = 0) {
    let visibleTime = state == .playing || state == .paused ? elapsed : duration
    time.text = visibleTime.map(Self.formatTime) ?? "–:––"
    progress = duration.map { $0 > 0 ? elapsed / $0 : 0 } ?? 0
    switch state {
    case .ready, .paused:
      glyph.image = OkouIcon.uiImage("circle-play")
      accessibilityLabel = String(localized: "Play voice recording")
    case .playing:
      glyph.image = OkouIcon.uiImage("circle-pause")
      accessibilityLabel = String(localized: "Pause voice recording")
    case .loading:
      glyph.image = OkouIcon.uiImage("hourglass")
      accessibilityLabel = String(localized: "Loading voice recording")
    case .failed:
      glyph.image = OkouIcon.uiImage("circle-alert")
      accessibilityLabel = String(localized: "Retry voice recording")
    }
    accessibilityValue = visibleTime.map {
      Duration.seconds($0).formatted(.units(allowed: [.minutes, .seconds], width: .wide))
    }
    updateColors()
  }

  private static func formatTime(_ time: TimeInterval) -> String {
    let seconds = Int(time.rounded(.down))
    return "\(seconds / 60):" + String(format: "%02d", seconds % 60)
  }

  @objc private func updateColors() {
    chip.backgroundColor = UIColor(isHighlighted ? OkouColor.statePressed : OkouColor.muted)
    glyph.tintColor = UIColor(OkouColor.foreground)
    time.textColor = UIColor(OkouColor.mutedForeground)
    for (index, bar) in bars.enumerated() {
      let played = Double(index + 1) / Double(bars.count) <= progress
      bar.backgroundColor = UIColor(played ? OkouColor.foreground : OkouColor.mutedForeground)
    }
  }
}
