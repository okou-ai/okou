import ChatDomain
import UIKit

/// Native attachments are one editable position. Their payload is the canonical part,
/// including fields this client does not interpret; labels are only presentation.
enum ComposerAttributedDocument {
  static let pasteboardType = "ai.okou.composer.inline-parts"
  private static let envelopeSnapshotKey = NSAttributedString.Key("ai.okou.composer.envelopes")

  private final class EnvelopeSnapshot: NSObject {
    let document: ChatDraftDocument
    init(_ document: ChatDraftDocument) { self.document = document }
  }

  static func recordEnvelopes(in value: NSMutableAttributedString, document: ChatDraftDocument) {
    guard value.length > 0, document.parts.contains(where: { !isInline($0) }) else { return }
    value.addAttribute(
      envelopeSnapshotKey, value: EnvelopeSnapshot(document),
      range: NSRange(location: 0, length: value.length))
  }

  static var textAttributes: [NSAttributedString.Key: Any] {
    attributes(for: font)
  }
  static func attributes(for font: UIFont) -> [NSAttributedString.Key: Any] {
    [.font: font, .foregroundColor: UIColor.label]
  }
  static var font: UIFont { scaledFont(for: nil) }
  static func scaledFont(for traits: UITraitCollection?) -> UIFont {
    UIFontMetrics(forTextStyle: .body).scaledFont(
      for: .systemFont(ofSize: 16), compatibleWith: traits)
  }

  static func isInline(_ part: MessageJSON) -> Bool {
    ["text", "agent", "chat_thread", "template"].contains(part["type"]?.string ?? "")
  }

  static func attributed(
    _ document: ChatDraftDocument, font: UIFont = ComposerAttributedDocument.font
  ) -> NSAttributedString {
    let result = NSMutableAttributedString()
    for part in document.parts {
      if part["type"]?.string == "text", let text = part["text"]?.string {
        result.append(NSAttributedString(string: text, attributes: attributes(for: font)))
      } else if isInline(part) {
        result.append(
          NSAttributedString(attachment: ComposerReferenceAttachment(part: part, font: font)))
      }
    }
    result.addAttributes(attributes(for: font), range: NSRange(location: 0, length: result.length))
    recordEnvelopes(in: result, document: document)
    return result
  }

  static func inlineDocument(_ value: NSAttributedString) -> ChatDraftDocument {
    var parts: [MessageJSON] = []
    value.enumerateAttribute(.attachment, in: NSRange(location: 0, length: value.length)) {
      attachment, range, _ in
      if let attachment = attachment as? ComposerReferenceAttachment {
        parts.append(attachment.part)
      } else {
        appendText(value.attributedSubstring(from: range).string, to: &parts)
      }
    }
    return ChatDraftDocument(parts: parts)
  }

  /// Files and source envelopes are owned outside the text view. Anchor them to
  /// the surrounding editable content, retaining their order through native edits.
  /// Character tokens keep edits to emoji/combining sequences on valid boundaries.
  static func document(_ value: NSAttributedString, preserving original: ChatDraftDocument)
    -> ChatDraftDocument
  {
    let edited = inlineDocument(value)
    let old = tokens(original)
    let new = tokens(edited)
    if old == new { return original }
    // UIKit restores deleted runs with their attributes. A full cut leaves no
    // inline anchor; the restored snapshot recovers exact source/file positions.
    let envelopes = original.parts.filter { !isInline($0) }
    var restored: ChatDraftDocument?
    if !envelopes.isEmpty {
      value.enumerateAttribute(envelopeSnapshotKey, in: NSRange(location: 0, length: value.length))
      { snapshot, _, stop in
        guard let snapshot = snapshot as? EnvelopeSnapshot,
          snapshot.document.parts.filter({ !isInline($0) }) == envelopes,
          tokens(snapshot.document) == new
        else { return }
        restored = snapshot.document
        stop.pointee = true
      }
    }
    if let restored { return restored }
    var prefix = 0
    while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
    var suffix = 0
    while suffix < min(old.count, new.count) - prefix,
      old[old.count - suffix - 1] == new[new.count - suffix - 1]
    { suffix += 1 }

    var anchoredEnvelopes: [Int: [MessageJSON]] = [:]
    var offset = 0
    for part in original.parts {
      if isInline(part) {
        offset += part["type"]?.string == "text" ? (part["text"]?.string?.count ?? 0) : 1
      } else {
        let anchor: Int
        if offset <= prefix {
          anchor = offset
        } else if offset >= old.count - suffix {
          anchor = new.count - (old.count - offset)
        } else {
          anchor = prefix
        }
        anchoredEnvelopes[anchor, default: []].append(part)
      }
    }
    var parts: [MessageJSON] = []
    for index in 0...new.count {
      parts.append(contentsOf: anchoredEnvelopes[index] ?? [])
      guard index < new.count else { continue }
      switch new[index] {
      case .text(let text): appendText(text, to: &parts)
      case .reference(let part): parts.append(part)
      }
    }
    return ChatDraftDocument(parts: parts)
  }

  static func clipboardText(_ value: NSAttributedString) -> String {
    inlineDocument(value).parts.map { part in
      let name = part["nameSnapshot"]?.string ?? part["titleSnapshot"]?.string ?? ""
      let escaped = name.replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "[", with: "\\[").replacingOccurrences(of: "]", with: "\\]")
      switch part["type"]?.string {
      case "agent": return "[\(escaped)](/agents/\(part["agentId"]?.string ?? "")/chat)"
      case "chat_thread": return "[\(escaped)](/chats/\(part["threadId"]?.string ?? ""))"
      case "text": return part["text"]?.string ?? ""
      default: return name
      }
    }.joined()
  }

  private enum Token: Equatable {
    case text(String)
    case reference(MessageJSON)
  }
  private static func tokens(_ document: ChatDraftDocument) -> [Token] {
    document.parts.flatMap { part -> [Token] in
      if part["type"]?.string == "text" {
        return (part["text"]?.string ?? "").map { .text(String($0)) }
      }
      return isInline(part) ? [.reference(part)] : []
    }
  }
  private static func appendText(_ text: String, to parts: inout [MessageJSON]) {
    guard !text.isEmpty else { return }
    if let last = parts.last, last["type"]?.string == "text" {
      parts[parts.count - 1] = .object([
        "type": .string("text"), "text": .string((last["text"]?.string ?? "") + text),
      ])
    } else {
      parts.append(.object(["type": .string("text"), "text": .string(text)]))
    }
  }
}

/// TextKit provides atomic selection, deletion and native editing geometry.
final class ComposerReferenceAttachment: NSTextAttachment {
  let part: MessageJSON
  var referenceFont = ComposerAttributedDocument.font
  var title: String { part["nameSnapshot"]?.string ?? part["titleSnapshot"]?.string ?? "" }
  var symbol: String {
    switch part["type"]?.string {
    case "agent": "person.crop.circle"
    case "chat_thread": "bubble.left"
    default: "doc"
    }
  }

  init(part: MessageJSON, font: UIFont) {
    self.part = part
    referenceFont = font
    super.init(data: nil, ofType: nil)
  }

  override var accessibilityLabel: String? {
    get {
      let kind =
        part["type"]?.string == "agent"
        ? "Agent" : (part["type"]?.string == "chat_thread" ? "Chat" : "Template")
      return kind + ": " + title
    }
    set { super.accessibilityLabel = newValue }
  }

  required init?(coder: NSCoder) {
    guard let data = coder.decodeObject(of: NSData.self, forKey: "composerPart") as? Data,
      let part = try? JSONDecoder().decode(MessageJSON.self, from: data)
    else { return nil }
    self.part = part
    super.init(coder: coder)
  }

  override func encode(with coder: NSCoder) {
    super.encode(with: coder)
    if let data = try? JSONEncoder().encode(part) {
      coder.encode(data as NSData, forKey: "composerPart")
    }
  }

  override func attachmentBounds(
    for textContainer: NSTextContainer?, proposedLineFragment lineFrag: CGRect,
    glyphPosition position: CGPoint, characterIndex charIndex: Int
  ) -> CGRect {
    let font = referenceFont
    let height = ceil(font.lineHeight + 4)
    let width = min(
      max(44, lineFrag.width - 4),
      ceil((title as NSString).size(withAttributes: [.font: font]).width) + height + 16)
    return CGRect(x: 0, y: font.descender - 2, width: width, height: height)
  }

  override func image(
    forBounds imageBounds: CGRect, textContainer: NSTextContainer?, characterIndex charIndex: Int
  ) -> UIImage? {
    let font = referenceFont
    return UIGraphicsImageRenderer(size: imageBounds.size).image { _ in
      UIColor.tertiarySystemFill.setFill()
      UIBezierPath(roundedRect: CGRect(origin: .zero, size: imageBounds.size), cornerRadius: 6)
        .fill()
      let iconSize = font.pointSize
      UIImage(
        systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: iconSize))?
        .withTintColor(.secondaryLabel, renderingMode: .alwaysOriginal)
        .draw(
          in: CGRect(
            x: 5, y: (imageBounds.height - iconSize) / 2, width: iconSize, height: iconSize))
      let paragraph = NSMutableParagraphStyle()
      paragraph.lineBreakMode = .byTruncatingTail
      (title as NSString).draw(
        in: CGRect(
          x: iconSize + 10, y: 2, width: max(0, imageBounds.width - iconSize - 15),
          height: font.lineHeight),
        withAttributes: [.font: font, .foregroundColor: UIColor.label, .paragraphStyle: paragraph])
    }
  }
}
