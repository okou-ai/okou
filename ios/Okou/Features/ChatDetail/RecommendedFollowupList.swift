import ChatDomain
import SwiftUI

struct RecommendedFollowupList: View {
  let source: ChatRecommendedFollowupSource
  let finishedAt: Date?
  let select: (String) -> Void

  var body: some View {
    let contentInsets = UIEdgeInsets(top: 0, left: 26, bottom: 0, right: 20)
    VStack(alignment: .leading, spacing: OkouSpace.sm) {
      // The web's run-section divider: a quiet serif italic label and a faint rule.
      HStack(spacing: OkouSpace.sm) {
        // The label keeps its line; the rule takes what is left.
        Group {
          if let finishedAt {
            Text("Keep going · \(Self.timestamp.string(from: finishedAt))")
          } else {
            Text("Keep going")
          }
        }
        .lineLimit(1)
        .layoutPriority(1)
        Rectangle()
          .fill(OkouColor.divider.opacity(0.4))
          .frame(height: 1)
          .accessibilityHidden(true)
      }
      .font(.okou(.subheadline, design: .serif).italic())
      .foregroundStyle(OkouColor.mutedForeground.opacity(0.5))
      .padding(.leading, contentInsets.left)
      .padding(.trailing, contentInsets.right)
      RecommendedFollowupRail(source: source, contentInsets: contentInsets, select: select)
    }
  }

  /// The web's chat timestamp: "Sep 8, 6:33 PM", localized.
  private static let timestamp: DateFormatter = {
    let formatter = DateFormatter()
    formatter.setLocalizedDateFormatFromTemplate("MMMdjmm")
    return formatter
  }()

}

private struct RecommendedFollowupRail: UIViewRepresentable {
  let source: ChatRecommendedFollowupSource
  let contentInsets: UIEdgeInsets
  let select: (String) -> Void
  @ScaledMetric(relativeTo: .subheadline) private var fontSize: CGFloat = 15
  @ScaledMetric(relativeTo: .subheadline) private var iconSize: CGFloat = OkouIconSize.inline
  @ScaledMetric(relativeTo: .subheadline) private var maximumCardWidth: CGFloat = 272

  func makeUIView(context: Context) -> RecommendedFollowupRailView {
    RecommendedFollowupRailView(contentInsets: contentInsets)
  }

  func updateUIView(_ view: RecommendedFollowupRailView, context: Context) {
    view.configure(
      source: source, fontSize: fontSize, iconSize: iconSize,
      maximumCardWidth: maximumCardWidth, select: select)
  }

  func sizeThatFits(
    _ proposal: ProposedViewSize, uiView: RecommendedFollowupRailView, context: Context
  )
    -> CGSize?
  {
    guard let width = proposal.width else { return nil }
    return uiView.measuredSize(width: width)
  }
}

/// A native suggestion rail preserves horizontal touch/VoiceOver scrolling and
/// exposes the complete untruncated prompt as each button's accessible name.
final class RecommendedFollowupRailView: UIScrollView {
  private var source: ChatRecommendedFollowupSource?
  private var buttons: [RecommendedFollowupButton] = []
  private var select: (String) -> Void = { _ in }
  private var fontSize: CGFloat?
  private var maximumCardWidth: CGFloat = 272

  init(contentInsets: UIEdgeInsets) {
    super.init(frame: .zero)
    showsHorizontalScrollIndicator = false
    alwaysBounceHorizontal = false
    contentInsetAdjustmentBehavior = .never
    contentInset = contentInsets
    accessibilityIdentifier = "recommended-followups"
    accessibilityLabel = String(localized: "Keep going")
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(
    source: ChatRecommendedFollowupSource, fontSize: CGFloat, iconSize: CGFloat,
    maximumCardWidth: CGFloat, select: @escaping (String) -> Void
  ) {
    self.select = select
    guard self.source != source || self.fontSize != fontSize else {
      return
    }
    self.fontSize = fontSize
    self.maximumCardWidth = maximumCardWidth
    if self.source != source {
      self.source = source
      for button in buttons { button.removeFromSuperview() }
      buttons = source.followups.enumerated().map { index, followup in
        let button = RecommendedFollowupButton()
        button.addAction(
          UIAction { [weak self] _ in self?.select(followup.prompt) }, for: .touchUpInside)
        button.accessibilityLabel = followup.prompt
        button.accessibilityValue = kindLabel(followup)
        button.accessibilityHint = "Adds or selects this text in your draft for you to send."
        button.accessibilityIdentifier = "recommended-followup-\(index)"
        addSubview(button)
        return button
      }
      contentOffset = CGPoint(x: -contentInset.left, y: 0)
    }
    for (button, followup) in zip(buttons, source.followups) {
      button.configure(
        prompt: followup.prompt, icon: followup.kind == .generate ? icon(followup) : nil,
        fontSize: fontSize, iconSize: iconSize)
    }
    setNeedsLayout()
    invalidateIntrinsicContentSize()
  }

  func measuredSize(width: CGFloat) -> CGSize {
    CGSize(width: width, height: sizes(width: width).map(\.height).max() ?? 44)
  }

  private func sizes(width: CGFloat) -> [CGSize] {
    let contentWidth = max(0, width - contentInset.left - contentInset.right)
    let maximum = min(maximumCardWidth, contentWidth * 0.72)
    return buttons.map { button in
      let natural = button.sizeThatFits(
        CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude))
      let cardWidth = min(maximum, natural.width)
      let size = button.sizeThatFits(CGSize(width: cardWidth, height: .greatestFiniteMagnitude))
      return CGSize(width: cardWidth, height: max(44, ceil(size.height)))
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let sizes = sizes(width: bounds.width)
    let height = sizes.map(\.height).max() ?? 44
    var x: CGFloat = 0
    for (button, size) in zip(buttons, sizes) {
      button.frame = CGRect(x: x, y: 0, width: size.width, height: height)
      x += size.width + 8
    }
    let size = CGSize(width: max(0, x - 8), height: height)
    if contentSize != size { contentSize = size }
  }

  private func icon(_ followup: ChatRecommendedFollowup) -> String {
    switch followup.generationType {
    case .image: "image"
    case .presentation: "chart-no-axes-combined"
    case .website: "link"
    default: "package"
    }
  }

  private func kindLabel(_ followup: ChatRecommendedFollowup) -> String {
    guard followup.kind == .generate else { return "Follow-up question" }
    switch followup.generationType {
    case .image: return "Image suggestion"
    case .presentation: return "Presentation suggestion"
    case .website: return "Website suggestion"
    default: return "Generation suggestion"
    }
  }
}

private final class RecommendedFollowupButton: UIButton {
  private let promptLabel = UILabel()
  private let typeIcon = UIImageView()
  private var iconWidth: CGFloat = 0

  init() {
    super.init(frame: .zero)
    // Web quick reply: the neutral hover layer, not a tinted fill, and supporting-text colour.
    layer.cornerRadius = OkouRadius.card
    layer.cornerCurve = .continuous
    backgroundColor = UIColor(OkouColor.stateHover)
    promptLabel.numberOfLines = 2
    promptLabel.lineBreakMode = .byTruncatingTail
    promptLabel.textColor = UIColor(OkouColor.mutedForeground.opacity(0.8))
    promptLabel.isUserInteractionEnabled = false
    promptLabel.isAccessibilityElement = false
    typeIcon.tintColor = UIColor(OkouColor.mutedForeground)
    typeIcon.contentMode = .scaleAspectFit
    typeIcon.isAccessibilityElement = false
    addSubview(promptLabel)
    addSubview(typeIcon)
    isAccessibilityElement = true
    accessibilityTraits = .button
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var isHighlighted: Bool {
    didSet {
      if isHighlighted {
        backgroundColor = UIColor(OkouColor.statePressed)
      } else {
        backgroundColor = UIColor(OkouColor.stateHover)
      }
    }
  }

  override func accessibilityActivate() -> Bool {
    guard isEnabled else { return false }
    // VoiceOver uses the same native control action as a touch.
    sendActions(for: .touchUpInside)
    return true
  }

  func configure(prompt: String, icon: String?, fontSize: CGFloat, iconSize: CGFloat) {
    promptLabel.text = prompt
    promptLabel.font = OkouTypography.font(ofSize: fontSize)
    typeIcon.image = icon.flatMap { OkouIcon.uiImage($0) }
    iconWidth = icon == nil ? 0 : iconSize
  }

  override func sizeThatFits(_ size: CGSize) -> CGSize {
    let leading = iconWidth > 0 ? iconWidth + 6 : 0
    let label = promptLabel.sizeThatFits(
      CGSize(width: max(1, size.width - 32 - leading), height: .greatestFiniteMagnitude))
    return CGSize(
      width: label.width + 32 + leading, height: max(44, ceil(max(label.height, iconWidth)) + 24))
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let leading = iconWidth > 0 ? iconWidth + 6 : 0
    let width = max(1, bounds.width - 32 - leading)
    let height = promptLabel.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
      .height
    promptLabel.frame = CGRect(x: 16 + leading, y: 12, width: width, height: height)
    typeIcon.frame = CGRect(
      x: 16, y: 12 + max(0, (promptLabel.font.lineHeight - iconWidth) / 2), width: iconWidth,
      height: iconWidth)
  }
}
