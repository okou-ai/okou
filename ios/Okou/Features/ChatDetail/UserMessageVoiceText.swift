import ChatDomain
import SwiftUI
import UIKit

/// A read-only TextKit document shares the composer's attachment geometry and playback buttons.
struct UserMessageVoiceText: UIViewRepresentable {
  let parts: [ChatUserMessage.Part]
  let webURL: URL
  let playback: VoiceClipPlayback?
  @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17
  @Environment(\.openURL) private var openURL

  init(parts: [ChatUserMessage.Part], webURL: URL, playback: VoiceClipPlayback?) {
    self.parts = parts
    self.webURL = webURL
    self.playback = playback
  }

  func makeUIView(context: Context) -> VoiceText {
    VoiceText()
  }

  func updateUIView(_ view: VoiceText, context: Context) {
    view.openURL = openURL
    view.update(parts: parts, webURL: webURL, playback: playback, fontSize: fontSize)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: VoiceText, context: Context) -> CGSize? {
    guard let width = proposal.width else { return nil }
    let text = uiView.textView
    let fittedWidth = min(width, ceil(text.attributedText.size().width))
    let size = text.sizeThatFits(CGSize(width: fittedWidth, height: .greatestFiniteMagnitude))
    return CGSize(width: fittedWidth, height: ceil(size.height))
  }

  final class VoiceText: UIView, UITextViewDelegate {
    let textView = UITextView()
    private let overlay = VoiceClipOverlay()
    private var parts: [ChatUserMessage.Part] = []
    private var webURL: URL?
    private var fontSize: CGFloat = 0
    private weak var playback: VoiceClipPlayback?
    var openURL: OpenURLAction?

    init() {
      super.init(frame: .zero)
      textView.isEditable = false
      textView.isSelectable = true
      textView.isScrollEnabled = false
      textView.backgroundColor = .clear
      textView.textContainerInset = .zero
      textView.textContainer.lineFragmentPadding = 0
      textView.delegate = self
      addSubview(textView)
      addSubview(overlay)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(
      parts: [ChatUserMessage.Part], webURL: URL, playback: VoiceClipPlayback?, fontSize: CGFloat
    ) {
      guard
        self.parts != parts || self.webURL != webURL || self.fontSize != fontSize
          || self.playback !== playback
      else { return }
      self.parts = parts
      self.webURL = webURL
      self.fontSize = fontSize
      self.playback = playback
      let font = OkouTypography.font(ofSize: fontSize)
      let content = NSMutableAttributedString()
      for part in parts {
        if part.type == "voice", let clips = part.clips {
          let attachment = ComposerReferenceAttachment(clips: clips, font: font)
          content.append(NSAttributedString(attachment: attachment, attributes: [.font: font]))
        } else {
          let linked = UserMessageInlineText.linkedText(for: part, webURL: webURL)
          let text = NSMutableAttributedString(attributedString: NSAttributedString(linked))
          let range = NSRange(location: 0, length: text.length)
          text.addAttributes(ComposerAttributedDocument.attributes(for: font), range: range)
          if part.isInlineReference {
            text.addAttributes(
              [
                .font: OkouTypography.font(ofSize: fontSize, weight: .medium),
                .backgroundColor: UIColor(OkouColor.muted)
              ], range: range)
          }
          content.append(text)
        }
      }
      textView.attributedText = content
      setNeedsLayout()
    }

    override func layoutSubviews() {
      super.layoutSubviews()
      textView.frame = bounds
      overlay.frame = bounds
      textView.layoutIfNeeded()
      overlay.position(in: textView, playback: playback, identifier: "message-voice-clip")
    }

    func textView(
      _ textView: UITextView, primaryActionFor textItem: UITextItem, defaultAction: UIAction
    ) -> UIAction? {
      guard case .link(let url) = textItem.content else { return defaultAction }
      return UIAction { [weak self] _ in self?.openURL?(url) }
    }
  }
}

/// With no authored text, all recorded segments share a single queue below the other attachments.
struct MessageVoicePlayer: UIViewRepresentable {
  let fileIDs: [String]
  let style: VoiceClipControl.Style
  let playback: VoiceClipPlayback?
  @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = 17

  init(fileIDs: [String], style: VoiceClipControl.Style, playback: VoiceClipPlayback?) {
    self.fileIDs = fileIDs
    self.style = style
    self.playback = playback
  }

  func makeUIView(context: Context) -> VoiceClipControl {
    let control = VoiceClipControl(
      fileIDs: fileIDs, style: style, playback: playback, fontSize: fontSize)
    control.accessibilityIdentifier = "message-voice-player"
    return control
  }

  func updateUIView(_ control: VoiceClipControl, context: Context) {
    control.playback = playback
    control.updateFontSize(fontSize)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: VoiceClipControl, context: Context)
    -> CGSize?
  {
    let width: CGFloat = style == .full ? 245 : 136
    let height: CGFloat = style == .full ? 48 : OkouControl.minimumTarget
    return CGSize(
      width: min(width, proposal.width ?? width), height: max(height, ceil(fontSize * 1.5)))
  }
}
