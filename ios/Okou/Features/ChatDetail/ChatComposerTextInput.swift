import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// UIKit owns editing, selection, undo, keyboard, and IME. Images join the same
/// attachment draft as file/photo imports, only after an explicit system paste.
struct ChatComposerTextInput: UIViewRepresentable {
  @Binding var text: String
  @Binding var isFocused: Bool
  let acceptsImages: Bool
  let isCurrent: @MainActor () -> Bool
  let pasteImages: ([NSItemProvider]) -> Void
  @Environment(\.isEnabled) private var isEnabled

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> ComposerTextView {
    let view = ComposerTextView()
    view.font = .systemFont(ofSize: 16)
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.delegate = context.coordinator
    view.pasteDelegate = context.coordinator
    view.accessibilityIdentifier = "message-input"
    view.accessibilityLabel = "Message Okou"
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    updateUIView(view, context: context)
    return view
  }

  func updateUIView(_ view: ComposerTextView, context: Context) {
    context.coordinator.input = self
    // Reassigning text during composition cancels the system's marked range.
    if view.text != text, view.markedTextRange == nil {
      let selection = view.selectedRange
      view.text = text
      let end = (text as NSString).length
      view.selectedRange = NSRange(
        location: min(selection.location, end),
        length: min(selection.length, max(0, end - selection.location)))
    }
    view.isEditable = isEnabled
    view.acceptsImages = acceptsImages && isEnabled
    view.pasteImages = pasteImages
    view.pasteConfiguration = UIPasteConfiguration(
      acceptableTypeIdentifiers:
        view.acceptsImages
        ? [UTType.plainText.identifier, UTType.image.identifier] : [UTType.plainText.identifier])
    view.placeholder.isHidden = !view.text.isEmpty
    view.setFocused(isFocused)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context)
    -> CGSize?
  {
    guard let width = proposal.width else { return nil }
    let line = uiView.font?.lineHeight ?? 20
    let height = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
    return CGSize(width: width, height: isFocused ? min(max(height, line * 2), line * 6) : line)
  }

  static func dismantleUIView(_ view: ComposerTextView, coordinator: Coordinator) {
    view.delegate = nil
    view.pasteDelegate = nil
    view.pasteImages = { _ in }
    // A retired editor must not reclaim the keyboard if UIKit reattaches it.
    view.setFocused(false)
  }

  final class Coordinator: NSObject, UITextViewDelegate, UITextPasteDelegate {
    var input: ChatComposerTextInput
    init(_ input: ChatComposerTextInput) { self.input = input }

    func textViewDidChange(_ textView: UITextView) {
      // A reset retires this editor before SwiftUI dismantles its native view.
      guard input.isCurrent() else { return }
      input.text = textView.text
      (textView as? ComposerTextView)?.placeholder.isHidden = !textView.text.isEmpty
      textView.invalidateIntrinsicContentSize()
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      guard input.isCurrent() else { return }
      input.isFocused = true
    }
    func textViewDidEndEditing(_ textView: UITextView) {
      guard input.isCurrent() else { return }
      input.isFocused = false
    }

    func textPasteConfigurationSupporting(
      _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
      transform item: UITextPasteItem
    ) {
      // An image provider can also carry plain text. Ask UIKit to insert that
      // representation once, at the native selection, without inline attachments.
      guard item.itemProvider.hasItemConformingToTypeIdentifier(UTType.image.identifier) else {
        item.setDefaultResult()
        return
      }
      let complete: @MainActor @Sendable (String?) -> Void = { value in
        if let value { item.setResult(string: value) } else { item.setNoResult() }
      }
      item.itemProvider.loadObject(ofClass: NSString.self) { value, _ in
        let string = value as? String
        Task { @MainActor in complete(string) }
      }
    }
  }
}

final class ComposerTextView: UITextView {
  var acceptsImages = false
  var pasteImages: ([NSItemProvider]) -> Void = { _ in }
  let placeholder = UILabel()
  private var wantsFocus = false

  init() {
    super.init(frame: .zero, textContainer: nil)
    placeholder.text = "Message Okou"
    placeholder.font = .systemFont(ofSize: 16)
    placeholder.textColor = .placeholderText
    placeholder.isAccessibilityElement = false
    placeholder.isUserInteractionEnabled = false
    addSubview(placeholder)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func setFocused(_ focused: Bool) {
    wantsFocus = focused
    reconcileFocus()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    reconcileFocus()
  }

  private func reconcileFocus() {
    // SwiftUI can prepare the replacement editor before it has a window.
    guard window != nil else { return }
    if wantsFocus && !isFirstResponder { becomeFirstResponder() }
    if !wantsFocus && isFirstResponder { resignFirstResponder() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    placeholder.frame = CGRect(origin: .zero, size: placeholder.sizeThatFits(bounds.size))
  }

  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(UIResponderStandardEditActions.paste(_:)), isEditable, acceptsImages,
      UIPasteboard.general.hasImages
    {
      // Type availability is privacy-safe metadata. The payload is read only
      // after the user chooses Paste; UIKit otherwise hides image-only paste.
      return true
    }
    return super.canPerformAction(action, withSender: sender)
  }

  override func paste(_ sender: Any?) {
    guard isEditable, acceptsImages else {
      super.paste(sender)
      return
    }
    // Access the pasteboard only from this explicit system action, never on focus
    // or while deciding whether the editing menu can be shown.
    let providers = UIPasteboard.general.itemProviders
    guard
      providers.contains(where: { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) })
    else {
      super.paste(sender)
      return
    }
    paste(itemProviders: providers)
  }

  override func paste(itemProviders: [NSItemProvider]) {
    guard isEditable else { return }
    var seen = Set<ObjectIdentifier>()
    let providers = itemProviders.filter { seen.insert(ObjectIdentifier($0)).inserted }
    let images = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }
    guard !images.isEmpty else {
      super.paste(itemProviders: itemProviders)
      return
    }
    if acceptsImages { pasteImages(images) }
    let text = providers.filter {
      $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
    }
    // Image-only paste must preserve selected text. UIKit handles text replacement,
    // cursor placement and undo for mixed pastes just as it does for ordinary text.
    if !text.isEmpty { super.paste(itemProviders: text) }
  }
}
