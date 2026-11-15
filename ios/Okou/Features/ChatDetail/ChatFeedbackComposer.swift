import ChatData
import ChatDomain
import SwiftUI

/// Each quoted passage owns its native note editor. Text gaps keep the canonical order.
struct ChatFeedbackComposer: View {
  let state: ComposerDraftStore
  let inputID: UUID
  @Binding var isFocused: Bool
  let acceptsImages: Bool
  var placeholder = String(localized: "Message Okou")
  var showsTrailingParagraph = true
  var sourceTitle: String? = nil
  var returnKeyPreference = ComposerReturnKeyPreference.newline
  var canSendFromKeyboard = false
  var submitFromKeyboard: (@MainActor () -> Void)? = nil
  @State private var focusedBlock: UUID?
  @State private var contentHeight: CGFloat = 24

  var body: some View {
    let generation = state.editorGeneration
    let blocks = state.editorBlocks
    let appendID = blocks.last(where: { $0.isFeedback || $0.hasParagraph })?.id ?? blocks.last?.id
    ScrollViewReader { scroll in
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.md) {
          ForEach(Array(blocks.enumerated()), id: \.element.id) { order, block in
            if block.isFeedback || !block.content.text.isEmpty
              || !block.content.contextLabels.isEmpty
              || (block.id == blocks.last?.id
                && (showsTrailingParagraph || !state.document.hasFeedback))
              || focusedBlock == block.id
            {
              VStack(alignment: .leading, spacing: OkouSpace.sm) {
                if let quote = block.quote {
                  ChatFeedbackReference(
                    quote: quote, sourceTitle: sourceTitle, id: block.id
                  ) {
                    state.removeFeedback(block.id)
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
                    state.signals.isCurrent(generation: generation, blockID: block.id)
                      && state.attachments.inputID == inputID
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
                  inputReady: { state.voice?.startRequestedInputIfReady() },
                  placeholder: block.isFeedback
                    ? (sourceTitle == nil
                      ? String(localized: "Ask or comment on this quote")
                      : String(localized: "Add a message")) : placeholder,
                  identifier: block.isFeedback ? "feedback-note-\(block.id)" : "message-input",
                  expanded: state.document.hasFeedback || isFocused,
                  returnKeyPreference: returnKeyPreference,
                  canSendFromKeyboard: canSendFromKeyboard,
                  submitFromKeyboard: submitFromKeyboard
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
      .onChange(of: state.voice?.phase, initial: true) { _, phase in
        guard phase == state.voice?.phase else { return }
        if phase == .starting || phase == .recording {
          focusedBlock = nil
          isFocused = false
        }
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

/// A Fork keeps its quote and source together; ordinary Quote retains the full passage.
private struct ChatFeedbackReference: View {
  let quote: String
  let sourceTitle: String?
  let id: UUID
  let remove: () -> Void

  var body: some View {
    if let sourceTitle {
      HStack(spacing: OkouSpace.sm) {
        OkouIcon("quote", size: OkouIconSize.reference)
          .foregroundStyle(OkouColor.mutedForeground)
        VStack(alignment: .leading, spacing: OkouSpace.xs) {
          Text(verbatim: quote)
            .font(.okou(.subheadline))
            .foregroundStyle(OkouColor.foreground)
            .lineLimit(1)
          Text("From \(sourceTitle)")
            .font(.okou(.footnote))
            .foregroundStyle(OkouColor.mutedForeground)
            .lineLimit(1)
            .accessibilityIdentifier("fork-source")
        }
        .layoutPriority(1)
        removeButton
      }
      .padding(.leading, OkouSpace.sm)
      .padding(.vertical, OkouSpace.xs)
      .background(OkouColor.nestedFill, in: RoundedRectangle(cornerRadius: OkouRadius.control))
      .overlay {
        RoundedRectangle(cornerRadius: OkouRadius.control)
          .strokeBorder(OkouColor.borderOnFill, lineWidth: OkouSpace.hairline)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    } else {
      HStack(alignment: .top, spacing: OkouSpace.sm) {
        Text(verbatim: quote)
          .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.leading, OkouSpace.ten)
          .overlay(alignment: .leading) {
            Rectangle().fill(OkouColor.borderOnFill).frame(width: 2)
          }
        removeButton
      }
    }
  }

  private var removeButton: some View {
    Button(action: remove) {
      OkouToolbarIcon("x").frame(
        width: OkouControl.minimumTarget, height: OkouControl.minimumTarget)
    }
    .accessibilityLabel("Remove feedback")
    .accessibilityIdentifier("remove-feedback-\(id)")
  }
}
