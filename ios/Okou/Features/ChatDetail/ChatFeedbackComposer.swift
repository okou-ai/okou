import ChatDomain
import SwiftUI

/// Each quoted passage owns its native note editor. Text gaps keep the canonical order.
struct ChatFeedbackComposer: View {
  let state: ComposerDraftStore
  let inputID: UUID
  @Binding var isFocused: Bool
  let acceptsImages: Bool
  @State private var focusedBlock: UUID?
  @State private var contentHeight: CGFloat = 24

  var body: some View {
    let generation = state.editorGeneration
    let blocks = state.editorBlocks
    let appendID = blocks.last(where: { $0.isFeedback || $0.hasParagraph })?.id ?? blocks.last?.id
    ScrollViewReader { scroll in
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(Array(blocks.enumerated()), id: \.element.id) { order, block in
            if block.isFeedback || !block.content.text.isEmpty
              || !block.content.contextLabels.isEmpty || block.id == blocks.last?.id
              || focusedBlock == block.id
            {
              VStack(alignment: .leading, spacing: 8) {
                if let quote = block.quote {
                  HStack(alignment: .top, spacing: 8) {
                    Text(quote).font(.subheadline).foregroundStyle(.secondary)
                      .frame(maxWidth: .infinity, alignment: .leading)
                      .padding(.leading, 10)
                      .overlay(alignment: .leading) {
                        Rectangle().fill(.quaternary).frame(width: 2)
                      }
                    Button {
                      state.removeFeedback(block.id)
                    } label: {
                      Image(systemName: "xmark").frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("Remove feedback")
                    .accessibilityIdentifier("remove-feedback-\(block.id)")
                  }
                  .accessibilityIdentifier("feedback-quote-\(block.id)")
                }
                ChatComposerTextInput(
                  text: Binding(
                    get: {
                      state.editorBlocks.first(where: { $0.id == block.id })?.content.text ?? ""
                    },
                    set: { state.editBlock(block.id, text: $0) }),
                  isFocused: Binding(
                    get: { focusedBlock == block.id },
                    set: { focused in
                      if focused {
                        focusedBlock = block.id
                        isFocused = true
                      } else if focusedBlock == block.id {
                        focusedBlock = nil
                        isFocused = false
                      }
                    }),
                  acceptsImages: acceptsImages,
                  isCurrent: {
                    state.editorGeneration == generation && state.attachments.inputID == inputID
                      && state.editorBlocks.contains(where: { $0.id == block.id })
                  },
                  pasteImages: state.attachments.importPastedImages,
                  editor: state.editor, editorBlockID: block.id, editorOrder: order,
                  isAppendTarget: block.id == appendID,
                  document: Binding(
                    get: {
                      state.editorBlocks.first(where: { $0.id == block.id })?.content
                        ?? ChatDraftDocument()
                    },
                    set: { state.editBlock(block.id, document: $0) }),
                  searchableRanges: {
                    state.editorBlocks.first(where: { $0.id == block.id })?.searchableRanges ?? []
                  },
                  focusRequested: { state.requestEditorFocus(block.id) },
                  placeholder: block.isFeedback ? "Ask or comment on this quote" : "Message Okou",
                  identifier: block.isFeedback ? "feedback-note-\(block.id)" : "message-input",
                  expanded: state.document.hasFeedback
                )
              }
              .id(block.id)
            }
          }
        }
        .onGeometryChange(for: CGFloat.self) {
          $0.size.height
        } action: {
          contentHeight = $0
        }
      }
      .frame(height: min(contentHeight, 280))
      .onChange(of: state.focusRequest) { _, id in
        guard let request = id else { return }
        let id = request.blockID
        focusedBlock = id
        isFocused = true
        scroll.scrollTo(id, anchor: .bottom)
        state.consumeFocusRequest(request)
      }
      .onChange(of: state.editorGeneration) { _, _ in
        focusedBlock = isFocused ? state.editorBlocks.last?.id : nil
      }
      .onAppear {
        if let request = state.focusRequest {
          focusedBlock = request.blockID
          isFocused = true
          state.consumeFocusRequest(request)
        } else if isFocused {
          focusedBlock = blocks.last?.id
        }
      }
    }
  }
}
