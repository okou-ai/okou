import CCStateSwiftUI
import ChatData
import ChatDomain
import SwiftUI

/// A card owns its editor and tools. Neither the home nor the destination chat's draft is loaded.
@MainActor
final class ForYouDirection {
  let cardID: String
  let composer: ComposerDraftStore
  let models: ChatModelSelectionStore

  init(cardID: String, threadID: String?, commands: ChatCommands, workspace: WorkspaceStore) {
    self.cardID = cardID
    models = ChatModelSelectionStore(models: workspace.modelStore, threadID: threadID)
    composer = ComposerDraftStore(
      target: .unassigned, commands: commands, graph: workspace.graph,
      didFail: { [weak workspace] in workspace?.reportWorkspaceFailure($0) })
    if let block = composer.editorBlocks.first { composer.requestEditorFocus(block.id) }
  }

  func close() {
    composer.close()
    models.close()
  }
}

struct ForYouDirectionComposer: View {
  let direction: ForYouDirection
  let card: ForYouCard
  let suggestion: ForYouSuggestion
  let workspace: WorkspaceStore
  /// The confirmed chats for mentions, the workspace's status and whether a deck action is
  /// running, kept in the workspace session's Store.
  @ResolvedValue private var threads: [ChatThread]?
  @ResolvedValue private var actionStatus: WorkspaceStore.ActionStatus?
  @ResolvedValue private var deckBusy: Bool?

  init(
    direction: ForYouDirection, card: ForYouCard, suggestion: ForYouSuggestion,
    workspace: WorkspaceStore
  ) {
    self.direction = direction
    self.card = card
    self.suggestion = suggestion
    self.workspace = workspace
    _threads = ResolvedValue(workspace.list.threadsValue)
    _actionStatus = ResolvedValue(workspace.actionStatusValue)
    _deckBusy = ResolvedValue(workspace.forYou.busyValue)
  }

  var body: some View {
    let composer = direction.composer
    let busy = deckBusy ?? workspace.forYou.busy
    VStack(alignment: .leading, spacing: OkouSpace.xs) {
      ForEach(suggestion.customOption.draft.draftAttachments ?? [], id: \.id) { file in
        Label(file.filename, okouSymbol: "paperclip")
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
      }
      ChatComposerView(
        isBusy: busy, showsProgress: busy,
        canStop: false, needsUpgrade: (actionStatus ?? workspace.actionStatus).needsUpgrade,
        error: nil,
        attachmentURL: workspace.webURL, draftState: composer,
        submit: { await workspace.forYou.sendDirection(card, from: direction) }, refresh: nil,
        modelSelection: direction.models, connectorSelection: direction.models.connectors,
        mentionSource: ComposerMentionSource(threads: threads ?? workspace.list.threads),
        workflowSource: workspace.composerWorkflows, writesDirection: true,
        placeholder: String(localized: "What do you have in mind?")
      )
    }
    // The card's editor is independent of the chat panel beneath this presentation.
    .environment(\.workspaceChatPresentation, nil)
  }
}
