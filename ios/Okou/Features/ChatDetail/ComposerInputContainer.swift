import UIKit

final class ComposerInputContainer: UIView {
  let textView = ComposerTextView()
  private let expansionButton = UIButton(type: .custom)
  private let voiceClipOverlay = ComposerVoiceClipOverlay()
  private var voiceClips: [ObjectIdentifier: ComposerVoiceClipControl] = [:]
  private var positioningVoiceClips = false

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
    guard !positioningVoiceClips, !bounds.isEmpty else { return }
    positioningVoiceClips = true
    defer { positioningVoiceClips = false }
    let storage = textView.textStorage
    var retained: [ObjectIdentifier: ComposerVoiceClipControl] = [:]
    var accessibilityOrder: [ComposerVoiceClipControl] = []
    storage.enumerateAttribute(
      .attachment, in: NSRange(location: 0, length: storage.length)
    ) { value, range, _ in
      guard let attachment = value as? ComposerReferenceAttachment,
        !attachment.voiceFileIDs.isEmpty,
        let frame = voiceClipFrame(for: attachment, range: range)
      else { return }
      let id = ObjectIdentifier(attachment)
      let control =
        voiceClips[id]
        ?? ComposerVoiceClipControl(
          fileIDs: attachment.voiceFileIDs, editor: textView,
          fontSize: attachment.referenceFont.pointSize)
      control.updateFontSize(attachment.referenceFont.pointSize)
      control.frame = frame
      control.isHidden = !frame.intersects(voiceClipOverlay.bounds)
      if control.superview == nil { voiceClipOverlay.addSubview(control) }
      retained[id] = control
      if !control.isHidden { accessibilityOrder.append(control) }
    }
    for (id, control) in voiceClips where retained[id] == nil {
      control.removeFromSuperview()
    }
    voiceClips = retained
    voiceClipOverlay.accessibilityElements = accessibilityOrder
  }

  private func voiceClipFrame(for attachment: ComposerReferenceAttachment, range: NSRange)
    -> CGRect?
  {
    let start = textView.beginningOfDocument
    guard let left = textView.position(from: start, offset: range.location),
      let right = textView.position(from: left, offset: range.length),
      let textRange = textView.textRange(from: left, to: right),
      let line = textView.selectionRects(for: textRange).first(where: { !$0.rect.isEmpty })
    else { return nil }
    let rect = voiceClipOverlay.convert(line.rect, from: textView)
    let clip = attachment.voiceBounds(availableWidth: textView.bounds.width)
    return CGRect(
      x: rect.minX, y: rect.midY - clip.height / 2, width: clip.width, height: clip.height)
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

// The editor still receives touches on every part of the canvas except an actual clip.
private final class ComposerVoiceClipOverlay: UIView {
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    super.point(inside: point, with: event)
      && subviews.contains { !$0.isHidden && $0.frame.contains(point) }
  }
}
