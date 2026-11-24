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
      target: .unassigned, commands: commands,
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

  var body: some View {
    @Bindable var composer = direction.composer
    VStack(alignment: .leading, spacing: OkouSpace.xs) {
      ForEach(suggestion.customOption.draft.draftAttachments ?? [], id: \.id) { file in
        Label(file.filename, okouSymbol: "paperclip")
          .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
      }
      ChatComposerView(
        draft: $composer.text,
        isBusy: workspace.forYou.busy, showsProgress: workspace.forYou.busy,
        canStop: false, needsUpgrade: workspace.needsUpgrade, error: nil,
        attachmentURL: workspace.webURL, attachments: composer.attachments, draftState: composer,
        submit: { await workspace.forYou.sendDirection(card, from: direction) }, refresh: nil,
        modelSelection: direction.models, connectorSelection: direction.models.connectors,
        mentionSource: ComposerMentionSource(threads: workspace.list.threads),
        workflowSource: workspace.composerWorkflows, writesDirection: true,
        placeholder: String(localized: "What do you have in mind?")
      )
    }
    // The card's editor is independent of the chat panel beneath this presentation.
    .environment(\.workspaceChatPresentation, nil)
  }
}
