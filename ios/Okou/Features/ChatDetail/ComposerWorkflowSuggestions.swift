import ChatData
import Observation
import UIKit

/// One native slash interaction; all offsets are UITextView UTF-16 offsets.
@MainActor @Observable
final class ComposerWorkflowSuggestions {
  private(set) var query: String?
  private(set) var selectedIndex = -1
  private(set) var isLoading = false
  private(set) var error: String?
  private var workflows: [ComposerWorkflow] = []
  private var recent: [String] = []
  private var source: ComposerWorkflowSource?
  private var agentID: String?
  @ObservationIgnored private weak var view: ComposerTextView?
  @ObservationIgnored private var range: NSRange?
  @ObservationIgnored private var dismissed: String?
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private var requestID = UUID()
  @ObservationIgnored private var isCurrent: @MainActor () -> Bool = { false }
  @ObservationIgnored private var focusRequested: @MainActor () -> Void = {}

  var matches: [ComposerWorkflow] {
    guard let query, source?.isClosed == false else { return [] }
    return ComposerWorkflowSearch.matches(workflows, query: query, recent: recent)
  }

  func configure(source: ComposerWorkflowSource?, agentID: String?) {
    guard self.source !== source || self.agentID != agentID else { return }
    dismiss()
    self.source = source
    self.agentID = agentID
    dismissed = nil
  }

  func update(
    in view: ComposerTextView, textChanged: Bool = false,
    isCurrent: @escaping @MainActor () -> Bool,
    focusRequested: @escaping @MainActor () -> Void
  ) {
    guard isCurrent() else { return }
    if textChanged { dismissed = nil }
    guard source?.isClosed == false, agentID != nil, view.isFirstResponder, view.isEditable,
      view.markedTextRange == nil, !view.isSettlingComposition,
      let range = ComposerWorkflowSearch.activeRange(
        in: view.text ?? "", selection: view.selectedRange)
    else {
      if self.view === view { clear() }
      return
    }
    let query = (view.text as NSString).substring(
      with: NSRange(location: range.location + 1, length: range.length - 1))
    let key = "\(ObjectIdentifier(view))-\(range.location)-\(range.length)-\(query)"
    guard key != dismissed else { return }
    let opening = self.query == nil
    if self.query != query || self.view !== view || self.range != range {
      selectedIndex = query.isEmpty ? -1 : 0
      recent = source?.recentIDs() ?? []
    }
    self.view = view
    self.range = range
    self.isCurrent = isCurrent
    self.focusRequested = focusRequested
    self.query = query
    if opening { reload() }
  }

  func reload() {
    guard query != nil, let source, !source.isClosed, let agentID else { return }
    task?.cancel()
    let request = UUID()
    requestID = request
    workflows = []
    isLoading = true
    error = nil
    task = Task { [weak self] in
      do {
        let result = try await source.load(agentID: agentID)
        guard let self, !Task.isCancelled, requestID == request, isCurrent() else { return }
        workflows = result
        isLoading = false
        task = nil
      } catch {
        guard let self, !Task.isCancelled, requestID == request, isCurrent() else { return }
        self.error = error.localizedDescription
        isLoading = false
        task = nil
      }
    }
  }

  func dismiss() {
    if let view, let range, let query {
      dismissed = "\(ObjectIdentifier(view))-\(range.location)-\(range.length)-\(query)"
    }
    clear()
  }

  func unregister(_ view: ComposerTextView) {
    if self.view === view { clear() }
  }

  private func clear() {
    task?.cancel()
    task = nil
    requestID = UUID()
    view = nil
    range = nil
    query = nil
    workflows = []
    isLoading = false
    error = nil
    selectedIndex = -1
  }

  @discardableResult func handleKey(_ key: String, in view: ComposerTextView) -> Bool {
    guard self.view === view, isCurrent(), view.markedTextRange == nil,
      !view.isSettlingComposition, query != nil
    else { return false }
    if key == UIKeyCommand.inputEscape {
      dismiss()
      return true
    }
    let values = matches
    guard !values.isEmpty else { return false }
    switch key {
    case UIKeyCommand.inputDownArrow: selectedIndex = (selectedIndex + 1) % values.count
    case UIKeyCommand.inputUpArrow:
      selectedIndex = selectedIndex <= 0 ? values.count - 1 : selectedIndex - 1
    case "\r", "\t":
      guard values.indices.contains(selectedIndex) else { return false }
      insert(values[selectedIndex])
    default: return false
    }
    return true
  }

  func insert(_ workflow: ComposerWorkflow) {
    guard let view, isCurrent(), source?.isClosed == false, view.isEditable, view.isFirstResponder,
      view.markedTextRange == nil, !view.isSettlingComposition, let range,
      ComposerWorkflowSearch.activeRange(in: view.text ?? "", selection: view.selectedRange)
        == range,
      matches.contains(workflow),
      let start = view.position(from: view.beginningOfDocument, offset: range.location),
      let end = view.position(from: start, offset: range.length),
      let replacement = view.textRange(from: start, to: end)
    else { return }
    let after = (view.text as NSString).substring(from: NSMaxRange(range))
    let token = "/" + workflow.name + (after.hasPrefix(" ") ? "" : " ")
    // UITextInput replacement preserves attributed runs outside the slash token
    // and participates in UIKit's native undo and selection machinery.
    view.replace(replacement, withText: token)
    view.selectedRange = NSRange(location: range.location + token.utf16.count, length: 0)
    view.delegate?.textViewDidChange?(view)
    dismiss()
    focusRequested()
    view.scrollRangeToVisible(view.selectedRange)
  }
}
