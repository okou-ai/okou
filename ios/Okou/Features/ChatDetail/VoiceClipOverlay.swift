import UIKit

/// TextKit lays out one atomic character per voice part. Only its playback button intercepts taps.
final class VoiceClipOverlay: UIView {
  private var voiceClips: [ObjectIdentifier: VoiceClipControl] = [:]
  private var positioningVoiceClips = false

  func position(
    in textView: UITextView, playback: VoiceClipPlayback?, identifier: String,
    isCurrent: @escaping @MainActor () -> Bool = { true }
  ) {
    guard !positioningVoiceClips, !bounds.isEmpty else { return }
    positioningVoiceClips = true
    defer { positioningVoiceClips = false }
    let storage = textView.textStorage
    var retained: [ObjectIdentifier: VoiceClipControl] = [:]
    var accessibilityOrder: [VoiceClipControl] = []
    storage.enumerateAttribute(
      .attachment, in: NSRange(location: 0, length: storage.length)
    ) { value, range, _ in
      guard let attachment = value as? ComposerReferenceAttachment,
        !attachment.voiceFileIDs.isEmpty,
        let frame = voiceClipFrame(for: attachment, range: range, in: textView)
      else { return }
      let id = ObjectIdentifier(attachment)
      let control =
        voiceClips[id]
        ?? VoiceClipControl(
          fileIDs: attachment.voiceFileIDs, style: .inline, playback: playback,
          fontSize: attachment.referenceFont.pointSize,
          isCurrent: isCurrent)
      control.playback = playback
      control.accessibilityIdentifier = identifier
      control.updateFontSize(attachment.referenceFont.pointSize)
      control.frame = frame
      control.isHidden = !frame.intersects(bounds)
      if control.superview == nil { addSubview(control) }
      retained[id] = control
      if !control.isHidden { accessibilityOrder.append(control) }
    }
    for (id, control) in voiceClips where retained[id] == nil {
      control.removeFromSuperview()
    }
    voiceClips = retained
    accessibilityElements = accessibilityOrder
  }

  private func voiceClipFrame(
    for attachment: ComposerReferenceAttachment, range: NSRange, in textView: UITextView
  )
    -> CGRect?
  {
    let start = textView.beginningOfDocument
    guard let left = textView.position(from: start, offset: range.location),
      let right = textView.position(from: left, offset: range.length),
      let textRange = textView.textRange(from: left, to: right),
      let line = textView.selectionRects(for: textRange).first(where: { !$0.rect.isEmpty })
    else { return nil }
    let rect = convert(line.rect, from: textView)
    let clip = attachment.voiceBounds(availableWidth: textView.bounds.width)
    return CGRect(
      x: rect.minX, y: rect.midY - clip.height / 2, width: clip.width, height: clip.height)
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    super.point(inside: point, with: event)
      && subviews.contains { !$0.isHidden && $0.frame.contains(point) }
  }
}
