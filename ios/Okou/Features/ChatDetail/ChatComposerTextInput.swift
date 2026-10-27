import ChatDomain
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
  var editor: ComposerEditor? = nil
  var editorOrder = 0
  var isAppendTarget = true
  var document: Binding<ChatDraftDocument>? = nil
  var searchableRanges: (@MainActor () -> [NSRange])? = nil
  var focusRequested: (@MainActor () -> Void)? = nil
  var placeholder = "Message Okou"
  var identifier = "message-input"
  var expanded = false
  @Environment(\.isEnabled) private var isEnabled

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> ComposerInputContainer {
    let container = ComposerInputContainer()
    let view = container.textView
    view.font = ComposerAttributedDocument.scaledFont(for: view.traitCollection)
    view.adjustsFontForContentSizeCategory = true
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.delegate = context.coordinator
    view.pasteDelegate = context.coordinator
    view.accessibilityIdentifier = "message-input"
    view.accessibilityLabel = "Message Okou"
    container.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    updateUIView(container, context: context)
    return container
  }

  func updateUIView(_ container: ComposerInputContainer, context: Context) {
    let view = container.textView
    context.coordinator.input = self
    view.mentionEditor = editor
    view.workflowSuggestions = editor?.workflows
    view.updateWorkflows = { [weak coordinator = context.coordinator, weak view] textChanged in
      guard let coordinator, let view else { return }
      coordinator.input.editor?.workflows.update(
        in: view, textChanged: textChanged,
        isCurrent: { [weak coordinator] in coordinator?.input.isCurrent() == true },
        focusRequested: { [weak coordinator] in coordinator?.input.focusRequested?() })
    }
    view.isCurrent = isCurrent
    view.usesStructuredDocument = document != nil
    editor?.register(
      view, order: editorOrder, canAppend: isAppendTarget,
      isCurrent: { [weak coordinator = context.coordinator] in
        coordinator?.input.isCurrent() == true
      },
      searchableRanges: { [weak coordinator = context.coordinator] in
        coordinator?.input.searchableRanges?()
      },
      focusRequested: { [weak coordinator = context.coordinator] in
        coordinator?.input.focusRequested?()
      })
    // Reassigning text during composition cancels the system's marked range.
    let newDocument = document?.wrappedValue
    if view.markedTextRange == nil,
      newDocument.map({ $0 != view.composerDocument }) ?? (view.text != text)
    {
      let selection = view.selectedRange
      view.isApplyingDocument = true
      if let newDocument {
        view.attributedText = ComposerAttributedDocument.attributed(
          newDocument, font: ComposerAttributedDocument.scaledFont(for: view.traitCollection))
        view.composerDocument = newDocument
      } else {
        view.text = text
      }
      // Remote hydration/conflict resolution replaces the editor's document;
      // native undo must never restore a different device's previous snapshot.
      view.undoManager?.removeAllActions()
      let end = (view.text as NSString).length
      view.selectedRange = NSRange(
        location: min(selection.location, end),
        length: min(selection.length, max(0, end - selection.location)))
      view.typingAttributes = view.composerTextAttributes
      view.isApplyingDocument = false
    }
    view.placeholder.text = placeholder
    view.accessibilityLabel = placeholder
    view.accessibilityIdentifier = identifier
    view.isEditable = isEnabled
    view.acceptsImages = acceptsImages && isEnabled
    view.pasteImages = pasteImages
    view.pasteConfiguration = UIPasteConfiguration(
      acceptableTypeIdentifiers:
        view.acceptsImages
        ? [
          ComposerAttributedDocument.pasteboardType, UTType.plainText.identifier,
          UTType.image.identifier,
        ]
        : [ComposerAttributedDocument.pasteboardType, UTType.plainText.identifier])
    view.placeholder.isHidden = !view.text.isEmpty
    container.expandsOnTap = isEnabled && !isFocused && !expanded
    view.setFocused(isFocused)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerInputContainer, context: Context)
    -> CGSize?
  {
    guard let width = proposal.width else { return nil }
    let line = uiView.textView.font?.lineHeight ?? 20
    let height = uiView.textView.sizeThatFits(
      CGSize(width: width, height: .greatestFiniteMagnitude)
    ).height
    return CGSize(
      width: width, height: isFocused || expanded ? min(max(height, line * 2), line * 6) : line)
  }

  static func dismantleUIView(_ container: ComposerInputContainer, coordinator: Coordinator) {
    let view = container.textView
    coordinator.input.editor?.unregister(view)
    view.delegate = nil
    view.pasteDelegate = nil
    view.pasteImages = { _ in }
    view.isCurrent = { false }
    view.mentionEditor = nil
    view.workflowSuggestions?.unregister(view)
    view.workflowSuggestions = nil
    view.updateWorkflows = { _ in }
    // A retired editor must not reclaim the keyboard if UIKit reattaches it.
    view.setFocused(false)
  }

  final class Coordinator: NSObject, UITextViewDelegate, UITextPasteDelegate {
    var input: ChatComposerTextInput
    init(_ input: ChatComposerTextInput) { self.input = input }

    func textViewDidChange(_ textView: UITextView) {
      // A reset retires this editor before SwiftUI dismantles its native view.
      guard input.isCurrent() else { return }
      guard let view = textView as? ComposerTextView, !view.isApplyingDocument else { return }
      if let binding = input.document {
        let document = ComposerAttributedDocument.document(
          view.attributedText, preserving: view.composerDocument)
        view.composerDocument = document
        ComposerAttributedDocument.recordEnvelopes(in: view.textStorage, document: document)
        binding.wrappedValue = document
      } else {
        input.text = textView.text
      }
      (textView as? ComposerTextView)?.placeholder.isHidden = !textView.text.isEmpty
      textView.invalidateIntrinsicContentSize()
      input.editor?.updateMention(in: view, textChanged: true)
      view.updateWorkflows(true)
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
      guard input.isCurrent(), let view = textView as? ComposerTextView, !view.isApplyingDocument
      else { return }
      if view.markedTextRange == nil {
        view.typingAttributes = view.composerTextAttributes
      }
      input.editor?.updateMention(in: view)
      view.updateWorkflows(false)
    }

    func textViewDidBeginEditing(_ textView: UITextView) {
      guard input.isCurrent() else { return }
      if !input.isFocused { input.isFocused = true }
      // Focus changes the representable's minimum line count, even without a text edit.
      textView.invalidateIntrinsicContentSize()
      if let view = textView as? ComposerTextView {
        input.editor?.updateMention(in: view)
        view.updateWorkflows(false)
      }
    }
    func textViewDidEndEditing(_ textView: UITextView) {
      guard input.isCurrent() else { return }
      if input.isFocused { input.isFocused = false }
      textView.invalidateIntrinsicContentSize()
      input.editor?.dismissMentions()
      if let view = textView as? ComposerTextView { input.editor?.workflows.unregister(view) }
    }

    func textPasteConfigurationSupporting(
      _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
      transform item: UITextPasteItem
    ) {
      if input.document != nil,
        item.itemProvider.hasItemConformingToTypeIdentifier(
          ComposerAttributedDocument.pasteboardType)
      {
        item.itemProvider.loadDataRepresentation(
          forTypeIdentifier: ComposerAttributedDocument.pasteboardType
        ) { data, _ in
          Task { @MainActor [weak self] in
            guard let self, self.input.isCurrent(), let data,
              let document = try? JSONDecoder().decode(ChatDraftDocument.self, from: data),
              document.isSupported, document.parts.allSatisfy(ComposerAttributedDocument.isInline)
            else {
              item.setNoResult()
              return
            }
            item.setResult(
              attributedString: ComposerAttributedDocument.attributed(
                document,
                font: (textPasteConfigurationSupporting as? ComposerTextView)?.font
                  ?? ComposerAttributedDocument.font))
          }
        }
        return
      }
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
  weak var workflowSuggestions: ComposerWorkflowSuggestions?
  var updateWorkflows: (Bool) -> Void = { _ in }
  var acceptsImages = false
  var pasteImages: ([NSItemProvider]) -> Void = { _ in }
  let placeholder = UILabel()
  var composerDocument = ChatDraftDocument()
  var usesStructuredDocument = false
  var isApplyingDocument = false
  var isCurrent: @MainActor () -> Bool = { true }
  weak var mentionEditor: ComposerEditor?
  private(set) var isSettlingComposition = false
  private var wantsFocus = false
  var composerTextAttributes: [NSAttributedString.Key: Any] {
    ComposerAttributedDocument.attributes(
      for: ComposerAttributedDocument.scaledFont(for: traitCollection))
  }

  init() {
    super.init(frame: .zero, textContainer: nil)
    placeholder.text = "Message Okou"
    placeholder.font = ComposerAttributedDocument.font
    placeholder.adjustsFontForContentSizeCategory = true
    placeholder.textColor = .placeholderText
    placeholder.isAccessibilityElement = false
    placeholder.isUserInteractionEnabled = false
    addSubview(placeholder)
    registerForTraitChanges([
      UITraitPreferredContentSizeCategory.self, UITraitUserInterfaceStyle.self,
    ]) {
      (view: ComposerTextView, _: UITraitCollection) in
      view.refreshAppearance()
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  /// Programmatic rich edits join this text view's undo manager; UIKit continues
  /// to own ordinary typing, selection replacement, deletion and marked text.
  func replaceCharacters(in range: NSRange, with value: NSAttributedString, selection: NSRange) {
    guard isCurrent(), isEditable, markedTextRange == nil,
      range.location <= textStorage.length, NSMaxRange(range) <= textStorage.length
    else { return }
    let previous = textStorage.attributedSubstring(from: range)
    let previousSelection = selectedRange
    undoManager?.registerUndo(withTarget: self) { view in
      view.replaceCharacters(
        in: NSRange(location: range.location, length: value.length), with: previous,
        selection: previousSelection)
    }
    let insertion = NSMutableAttributedString(attributedString: value)
    insertion.addAttributes(
      composerTextAttributes, range: NSRange(location: 0, length: insertion.length))
    insertion.enumerateAttribute(.attachment, in: NSRange(location: 0, length: insertion.length)) {
      value, _, _ in
      (value as? ComposerReferenceAttachment)?.referenceFont =
        ComposerAttributedDocument.scaledFont(for: traitCollection)
    }
    textStorage.replaceCharacters(in: range, with: insertion)
    let end = textStorage.length
    selectedRange = NSRange(
      location: min(selection.location, end),
      length: min(selection.length, max(0, end - selection.location)))
    typingAttributes = composerTextAttributes
    delegate?.textViewDidChange?(self)
    delegate?.textViewDidChangeSelection?(self)
  }

  override var keyCommands: [UIKeyCommand]? {
    let workflowsActive = workflowSuggestions?.query != nil
    guard markedTextRange == nil, !isSettlingComposition,
      workflowsActive || mentionEditor?.mentionQuery != nil
    else { return super.keyCommands }
    let hasRows =
      workflowsActive
      ? workflowSuggestions?.matches.isEmpty == false
      : mentionEditor?.mentionSuggestions.isEmpty == false
    var keys = [UIKeyCommand.inputEscape]
    if hasRows {
      keys.insert(contentsOf: [UIKeyCommand.inputUpArrow, UIKeyCommand.inputDownArrow], at: 0)
      if !workflowsActive
        || workflowSuggestions.map({ $0.matches.indices.contains($0.selectedIndex) }) == true
      {
        keys += ["\r", "\t"]
      }
    }
    return keys.map {
      let command = UIKeyCommand(
        input: $0, modifierFlags: [], action: #selector(composerSuggestionKey(_:)))
      command.wantsPriorityOverSystemBehavior = true
      return command
    } + (super.keyCommands ?? [])
  }

  @objc private func composerSuggestionKey(_ command: UIKeyCommand) {
    guard let key = command.input else { return }
    if workflowSuggestions?.query != nil {
      workflowSuggestions?.handleKey(key, in: self)
    } else {
      mentionEditor?.handleMentionKey(key, in: self)
    }
  }

  override func insertText(_ text: String) {
    if text == "\n", markedTextRange == nil, !isSettlingComposition,
      mentionEditor?.handleMentionKey("\r", in: self) == true
    {
      return
    }
    let wasComposing = markedTextRange != nil
    super.insertText(text)
    if wasComposing { settleComposition() }
  }

  override func unmarkText() {
    let wasComposing = markedTextRange != nil
    super.unmarkText()
    if wasComposing { settleComposition() }
  }

  override func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
    super.setMarkedText(markedText, selectedRange: selectedRange)
    mentionEditor?.updateMention(in: self)
    updateWorkflows(false)
  }

  private func settleComposition() {
    // Some IMEs commit marked text before delivering the confirming Return.
    // Keep that event with UIKit, then resume suggestions on the next turn.
    isSettlingComposition = true
    DispatchQueue.main.async { [weak self] in
      guard let self, isCurrent() else { return }
      isSettlingComposition = false
      refreshAppearance()
      mentionEditor?.updateMention(in: self)
      updateWorkflows(false)
    }
  }

  override func copy(_ sender: Any?) {
    guard copyStructuredSelection() else {
      super.copy(sender)
      return
    }
  }

  override func cut(_ sender: Any?) {
    guard isEditable, copyStructuredSelection() else {
      super.cut(sender)
      return
    }
    replaceCharacters(
      in: selectedRange, with: NSAttributedString(string: ""),
      selection: NSRange(location: selectedRange.location, length: 0))
  }

  private func copyStructuredSelection() -> Bool {
    guard usesStructuredDocument, selectedRange.length > 0 else { return false }
    let selection = attributedText.attributedSubstring(from: selectedRange)
    let document = ComposerAttributedDocument.inlineDocument(selection)
    // Export only the selected inline parts; native undo attributes may retain
    // source/file envelopes that must never become clipboard content.
    guard let data = try? JSONEncoder().encode(document)
    else { return false }
    UIPasteboard.general.setItems([
      [
        ComposerAttributedDocument.pasteboardType: data,
        UTType.utf8PlainText.identifier: Data(
          ComposerAttributedDocument.clipboardText(selection).utf8),
      ]
    ])
    return true
  }

  func setFocused(_ focused: Bool) {
    wantsFocus = focused
    reconcileFocus()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil { refreshAppearance() }
    reconcileFocus()
  }

  private func refreshAppearance() {
    guard markedTextRange == nil else { return }
    let scaled = ComposerAttributedDocument.scaledFont(for: traitCollection)
    font = scaled
    placeholder.font = scaled
    let range = NSRange(location: 0, length: textStorage.length)
    textStorage.enumerateAttribute(.attachment, in: range) { value, _, _ in
      (value as? ComposerReferenceAttachment)?.referenceFont = scaled
    }
    textStorage.addAttributes(composerTextAttributes, range: range)
    typingAttributes = composerTextAttributes
    invalidateIntrinsicContentSize()
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
