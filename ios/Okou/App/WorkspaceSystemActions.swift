import ChatData
import ChatDomain
import Foundation

extension WorkspaceStore {
  /// Puts `/name` at the start of the new chat's draft, as choosing the workflow from the
  /// composer's `/` menu does; whatever the draft already held stays after it.
  func useWorkflow(named name: String) {
    let token = "/" + name + " "
    guard !newChatDraft.hasPrefix(token) else { return }
    newChatDraft = token + newChatDraft
  }

  @discardableResult
  func openNewChatFromSystem(startVoiceInput: Bool = false) -> Bool {
    guard canOpenNewChatFromSystem else { return false }
    startNewChat()
    search.dismiss()
    if startVoiceInput {
      if let request = newComposer.focusRequest { newComposer.consumeFocusRequest(request) }
      newComposer.editor.dismissKeyboard()
      newComposer.voice?.requestStart()
    } else {
      newComposer.voice?.suspend()
      if let block = newComposer.editorBlocks.last {
        newComposer.requestEditorFocus(block.id)
      }
    }
    return true
  }

  var currentAgentName: String { "Okou" }

  var billingURL: URL { webURL.appending(path: "settings/billing") }

  var selectedAgentID: String? { selectedConversation?.thread.agentID }

  var newChatProject: ChatProject? {
    projects.projects.first { $0.id == newChatProjectID }
  }

  var newChatDraft: String {
    get { newComposer.text }
    set { newComposer.text = newValue }
  }

  var newAttachmentDraft: AttachmentDraftStore { newComposer.attachments }

  func setRead(_ thread: ChatThread, read: Bool) async {
    let conversation = residentConversations[thread.id]
    if !read { conversation?.setAutomaticReadSuppressed(true) }
    let succeeded = await list.setRead(thread, read: read)
    if read || !succeeded { conversation?.setAutomaticReadSuppressed(false) }
  }

  func deleteProject(_ id: String) async {
    if await projects.delete(id), !isClosed, newChatProjectID == id {
      removeNewChatProject()
    }
  }

  func prepareSettings() {
    guard !isClosed, !needsUpgrade else { return }
    do { try settingsResources.prepareSettings() } catch { reportWorkspaceFailure(error) }
  }

  func loadSettingsBilling() async {
    guard !isClosed, !needsUpgrade, !Task.isCancelled else { return }
    do { try await settingsResources.loadSettingsBilling() } catch is CancellationError {
    } catch { reportWorkspaceFailure(error) }
  }

  func refreshSettingsBilling() async {
    prepareSettings()
    await loadSettingsBilling()
  }

}
