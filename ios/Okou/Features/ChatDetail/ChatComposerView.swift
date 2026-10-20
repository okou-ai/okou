import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChatComposerView: View {
  @Binding var draft: String
  let isBusy: Bool
  let showsProgress: Bool
  let canStop: Bool
  let needsUpgrade: Bool
  let error: String?
  let attachmentURL: URL
  let attachments: AttachmentDraftStore
  var draftState: ComposerDraftStore? = nil
  let submit: @MainActor () async -> Void
  let refresh: (@MainActor () async -> Void)?

  var modelSelection: ChatModelSelectionStore? = nil

  @State private var isFocused = false
  @State private var showsPhotos = false
  @State private var showsFiles = false
  @State private var selectedPhotos: [PhotosPickerItem] = []
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var hasText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var hasContent: Bool {
    hasText || attachments.hasAttachments || draftState?.hasContent == true
  }
  private var expandsInput: Bool { isFocused || draftState?.document.hasFeedback == true }
  private var showsStop: Bool { canStop && !hasContent }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let state = draftState {
        if !state.document.isSupported {
          Text("This draft contains content this app cannot edit. Open it on the web.")
            .font(.caption).foregroundStyle(.red)
        }
        if !state.contextLabels.isEmpty {
          Text(state.contextLabels.joined(separator: " · "))
            .font(.caption).foregroundStyle(.secondary).lineLimit(3)
            .accessibilityLabel("Saved context: " + state.contextLabels.joined(separator: ", "))
        }
        if let draftError = state.error {
          Text(draftError).font(.caption).foregroundStyle(.red)
          if state.conflictingRemote != nil {
            HStack {
              Button("Keep this draft") { state.keepLocal() }.frame(minHeight: 44)
              Button("Use other device's draft") { state.useRemote() }.frame(minHeight: 44)
            }.font(.caption)
          } else {
            Button("Retry draft sync") { Task { await state.synchronize() } }.font(.caption)
          }
        }
      }
      if let modelSelection {
        ChatModelPickerButton(selection: modelSelection)
      }
      if !attachments.items.isEmpty {
        ChatAttachmentChips(draft: attachments, isDisabled: isBusy || needsUpgrade)
      }
      if attachments.importingCount > 0 {
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Preparing attachments…").font(.caption).foregroundStyle(.secondary)
        }
      }
      if let importError = attachments.error {
        HStack {
          Text(importError).font(.caption).foregroundStyle(.red)
          Spacer()
          Button {
            attachments.error = nil
          } label: {
            Image(systemName: "xmark")
              .frame(width: 44, height: 44)
          }
          .accessibilityLabel("Dismiss attachment error")
        }
      }
      if let error {
        VStack(alignment: .leading, spacing: 6) {
          Text(error).foregroundStyle(.red)
          if let refresh {
            HStack {
              Button("Refresh") { Task { await refresh() } }
              Spacer()
              Link("Open on web", destination: attachmentURL)
            }
          }
        }
        .font(.caption)
        .padding(.horizontal, 12)
      }

      let inputID = attachments.inputID
      let generation = draftState?.editorGeneration
      Group {
        if let state = draftState, state.document.hasFeedback {
          ChatFeedbackComposer(
            state: state, inputID: inputID, isFocused: $isFocused,
            acceptsImages: !isBusy && !needsUpgrade
          )
          .id(inputID)
        } else {
          ChatComposerTextInput(
            text: $draft, isFocused: $isFocused,
            acceptsImages: !isBusy && !needsUpgrade,
            isCurrent: {
              attachments.inputID == inputID && draftState?.editorGeneration == generation
            },
            pasteImages: attachments.importPastedImages,
            editor: draftState?.editor,
            searchableRanges: draftState == nil
              ? nil : { draftState?.editorBlocks.first?.searchableRanges ?? [] }
          )
          .id(inputID)
          .disabled(draftState?.document.isSupported == false)
          .onAppear {
            guard let state = draftState, let request = state.focusRequest else { return }
            isFocused = true
            state.consumeFocusRequest(request)
          }
        }
      }
      .accessibilityIdentifier("message-input")
      .padding(.leading, expandsInput ? 18 : 58)
      .padding(.trailing, expandsInput ? 18 : 58)
      .padding(.top, expandsInput ? 17 : 15)
      .padding(.bottom, expandsInput ? 62 : 15)
      .frame(minHeight: expandsInput ? 116 : 54, alignment: expandsInput ? .topLeading : .leading)
      .glassEffect(.regular, in: RoundedRectangle(cornerRadius: expandsInput ? 28 : 30))
      .overlay(alignment: expandsInput ? .bottomLeading : .leading) {
        Menu {
          Button("Photo Library", systemImage: "photo.on.rectangle") { showsPhotos = true }
          Button("Choose Files", systemImage: "folder") { showsFiles = true }
          if let state = draftState, state.hasContent || state.error != nil {
            Divider()
            Button("Clear draft", role: .destructive) { state.clear() }
          }
        } label: {
          Image(systemName: "plus")
            .font(.system(size: 22, weight: .regular))
            .frame(width: 44, height: 44)
        }
        .accessibilityLabel("Attachments")
        .disabled(isBusy || needsUpgrade)
        .padding(.leading, 8)
        .padding(.bottom, expandsInput ? 8 : 0)
      }
      .overlay(alignment: expandsInput ? .bottomTrailing : .trailing) {
        Button {
          if !showsStop {
            draftState?.editor.dismissKeyboard()
            isFocused = false
          }
          Task { await submit() }
        } label: {
          Group {
            if showsProgress {
              ProgressView()
                .controlSize(.small)
                .tint(Color(uiColor: .systemBackground))
            } else {
              Image(systemName: showsStop ? "stop.fill" : "arrow.up")
            }
          }
          .font(.system(size: 16, weight: .semibold))
          .frame(width: 22, height: 22)
          .foregroundStyle(Color(uiColor: .systemBackground))
        }
        .buttonStyle(.glassProminent)
        .buttonBorderShape(.circle)
        .controlSize(.small)
        .tint(Color.primary)
        .disabled(
          (!hasContent && !showsStop) || !attachments.isReady || isBusy || needsUpgrade
            || draftState?.canSend == false
            || (!showsStop && modelSelection?.canSend == false)
        )
        .accessibilityLabel(showsStop ? "Stop" : "Send message")
        .accessibilityIdentifier(showsStop ? "stop-message" : "send-message")
        .frame(width: 44, height: 44)
        .contentShape(Circle())
        .padding(.trailing, 7)
        .padding(.bottom, expandsInput ? 8 : 0)
      }
      .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: isFocused)
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 8)
    .photosPicker(
      isPresented: $showsPhotos, selection: $selectedPhotos,
      matching: .any(of: [.images, .videos]), preferredItemEncoding: .current
    )
    .onChange(of: selectedPhotos) { _, photos in
      guard !photos.isEmpty else { return }
      attachments.importPhotos(photos)
      selectedPhotos = []
    }
    .fileImporter(
      isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true
    ) {
      switch $0 {
      case .success(let urls): attachments.importFiles(urls)
      case .failure(let error): attachments.report(error)
      }
    }
  }
}
