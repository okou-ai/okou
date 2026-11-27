import UIKit

final class ComposerInputContainer: UIView {
  let textView = ComposerTextView()
  private let expansionButton = UIButton(type: .custom)
  private let voiceClipOverlay = VoiceClipOverlay()
  var expandsOnTap: Bool {
    get { !expansionButton.isHidden }
    set { expansionButton.isHidden = !newValue }
  }

  init() {
    super.init(frame: .zero)
    addSubview(textView)
    // A sibling control owns the compact activation tap so UITextView cannot
    // subsequently replace the end selection with the original tap position.
    expansionButton.isHidden = true
    expansionButton.isAccessibilityElement = false
    expansionButton.accessibilityIdentifier = "expand-message-input"
    expansionButton.addAction(
      UIAction { [weak self] _ in self?.expand() }, for: .touchUpInside)
    addSubview(expansionButton)
    voiceClipOverlay.clipsToBounds = true
    addSubview(voiceClipOverlay)
    textView.layoutVoiceClips = { [weak self] in self?.positionVoiceClips() }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    expansionButton.frame = bounds
    voiceClipOverlay.frame = bounds
    positionVoiceClips()
  }

  private func positionVoiceClips() {
    voiceClipOverlay.position(
      in: textView, playback: textView.voicePlayback, identifier: "composer-voice-clip",
      isCurrent: { [weak textView] in textView?.isCurrent() == true })
  }

  private func expand() {
    guard expandsOnTap, textView.isCurrent(), textView.isEditable,
      textView.becomeFirstResponder()
    else { return }
    expandsOnTap = false
    textView.setFocused(true)
    textView.selectedRange = NSRange(location: textView.textStorage.length, length: 0)
    textView.scrollRangeToVisible(textView.selectedRange)
  }
}
