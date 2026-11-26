import SwiftUI
import UIKit

/// A single playback target, whether TextKit places it among words or a row presents it alone.
final class VoiceClipControl: UIControl {
  enum Style: Hashable {
    case inline, compact, full
  }

  static let visualHeight: CGFloat = 28
  private static let barHeights: [CGFloat] = [
    5, 9, 16, 12, 6, 18, 24, 14, 7, 13, 20, 10, 5, 11, 18, 23, 14, 6, 12, 17, 8, 4
  ]
  private let glyph = UIImageView()
  private let disc = UIView()
  private let chip = UIView()
  private let time = UILabel()
  private let bars: [UIView]
  let fileIDs: [String]
  let style: Style
  weak var playback: VoiceClipPlayback? {
    didSet {
      guard oldValue !== playback else { return }
      oldValue?.detach(self)
      metadata?.cancel()
      metadata = nil
      duration = nil
      render()
      loadDurationIfNeeded()
    }
  }
  private let isCurrent: @MainActor () -> Bool
  private var metadata: Task<Void, Never>?
  var duration: TimeInterval?
  private var progress = 0.0

  nonisolated static func preferredWidth(font: UIFont) -> CGFloat {
    max(104, ceil(font.pointSize * 6))
  }

  init(
    fileIDs: [String], style: Style, playback: VoiceClipPlayback?, fontSize: CGFloat,
    isCurrent: @escaping @MainActor () -> Bool = { true }
  ) {
    self.fileIDs = fileIDs
    self.style = style
    self.playback = playback
    self.isCurrent = isCurrent
    bars = Self.barHeights.prefix(style == .full ? Self.barHeights.count : 7).map { _ in UIView() }
    super.init(frame: .zero)
    isAccessibilityElement = true
    accessibilityTraits = .button
    chip.isUserInteractionEnabled = false
    addSubview(chip)
    chip.addSubview(disc)
    disc.addSubview(glyph)
    glyph.contentMode = .scaleAspectFit
    for bar in bars { chip.addSubview(bar) }
    updateFontSize(fontSize)
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
      playback?.detach(self)
      return
    }

    loadDurationIfNeeded()
  }

  private func loadDurationIfNeeded() {
    guard window != nil, let playback, duration == nil, metadata == nil else { return }
    metadata = Task { [weak self, weak playback] in
      guard let playback, let fileIDs = self?.fileIDs else { return }
      let duration = await playback.duration(fileIDs)
      guard !Task.isCancelled, let self else { return }
      self.metadata = nil
      if let duration {
        self.duration = duration
        if !playback.owns(self) { self.render() }
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let inline = style == .inline
    let height = inline ? min(bounds.height, Self.visualHeight) : bounds.height
    let width = max(0, bounds.width - (inline ? OkouSpace.xs : 0))
    let inset: CGFloat
    let discSize: CGFloat
    let minimumTimeWidth: CGFloat
    switch style {
    case .inline:
      (inset, discSize, minimumTimeWidth) = (OkouSpace.xs, 20, 38)
      chip.layer.cornerRadius = OkouRadius.small
    case .compact:
      (inset, discSize, minimumTimeWidth) = (OkouSpace.sm, 26, 33)
      chip.layer.cornerRadius = 12
    case .full:
      (inset, discSize, minimumTimeWidth) = (OkouSpace.md, 32, 48)
      chip.layer.cornerRadius = height / 2
    }
    chip.frame = CGRect(x: 0, y: (bounds.height - height) / 2, width: width, height: height)
    disc.frame = CGRect(x: inset, y: (height - discSize) / 2, width: discSize, height: discSize)
    disc.layer.cornerRadius = discSize / 2
    let glyphInset: CGFloat = inline ? 0 : discSize / 4
    glyph.frame = disc.bounds.insetBy(dx: glyphInset, dy: glyphInset)
    let timeWidth = min(
      max(minimumTimeWidth, time.intrinsicContentSize.width),
      max(0, width - disc.frame.maxX - inset))
    time.frame = CGRect(
      x: width - timeWidth - (inline ? OkouSpace.sm : inset), y: 0, width: timeWidth, height: height
    )
    let gap: CGFloat = inline ? OkouSpace.xs : inset
    let start = disc.frame.maxX + gap
    let pitch = max(0, time.frame.minX - gap - start) / CGFloat(bars.count)
    for (index, bar) in bars.enumerated() {
      let barHeight = Self.barHeights[index] * (style == .full ? 1 : 0.67)
      bar.frame = CGRect(
        x: start + pitch * CGFloat(index), y: (height - barHeight) / 2,
        width: min(3, pitch / 2), height: barHeight)
      bar.layer.cornerRadius = bar.bounds.width / 2
    }
  }

  override func accessibilityActivate() -> Bool {
    toggle()
  }

  func updateFontSize(_ fontSize: CGFloat) {
    let size = max(12, fontSize * (style == .inline ? 0.71 : 0.82))
    if time.font?.pointSize != size {
      time.font = UIFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)
    }
  }

  @discardableResult private func toggle() -> Bool {
    guard isCurrent(), let playback else { return false }
    playback.toggle(self)
    return true
  }

  enum PlaybackState {
    case ready, loading, playing, paused, failed
  }

  func render(_ state: PlaybackState = .ready, elapsed: TimeInterval = 0) {
    let visibleTime = state == .playing || state == .paused ? elapsed : duration
    let label = visibleTime.map(Self.formatTime) ?? "–:––"
    if time.text != label {
      time.text = label
      setNeedsLayout()
    }
    progress = duration.map { $0 > 0 ? elapsed / $0 : 0 } ?? 0
    switch state {
    case .ready, .paused:
      glyph.image = OkouIcon.uiImage(style == .inline ? "circle-play" : "play")
      accessibilityLabel = String(localized: "Play voice recording")
    case .playing:
      glyph.image = OkouIcon.uiImage(style == .inline ? "circle-pause" : "pause")
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
    let fill = style == .compact ? OkouColor.gray50 : OkouColor.muted
    chip.backgroundColor = UIColor(isHighlighted ? OkouColor.statePressed : fill)
    chip.layer.borderWidth = OkouSpace.hairline
    chip.layer.borderColor = UIColor(OkouColor.border).resolvedColor(with: traitCollection).cgColor
    disc.backgroundColor = style == .inline ? .clear : UIColor(OkouColor.foreground)
    glyph.tintColor = UIColor(style == .inline ? OkouColor.foreground : OkouColor.background)
    time.textColor = UIColor(OkouColor.mutedForeground)
    for (index, bar) in bars.enumerated() {
      let played = Double(index + 1) / Double(bars.count) <= progress
      bar.backgroundColor = UIColor(
        played ? OkouMediaColor.voiceProgress : OkouColor.mutedForeground)
    }
  }
}
