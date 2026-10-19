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
  let supportsAttachments: Bool
  let submit: @MainActor () async -> Void
  let refresh: (@MainActor () async -> Void)?

  @FocusState private var isFocused: Bool
  @State private var showsPhotos = false
  @State private var showsFiles = false
  @State private var selectedPhotos: [PhotosPickerItem] = []
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var hasText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var hasContent: Bool { hasText || attachments.hasAttachments }
  private var showsStop: Bool { canStop && !hasContent }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
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

      TextField("Message Okou", text: $draft, axis: .vertical)
        .font(.system(size: 16))
        .lineLimit(isFocused ? 2...6 : 1...1)
        .focused($isFocused)
        .accessibilityIdentifier("message-input")
        .padding(.leading, isFocused ? 18 : 58)
        .padding(.trailing, isFocused ? 18 : 58)
        .padding(.top, isFocused ? 17 : 15)
        .padding(.bottom, isFocused ? 62 : 15)
        .frame(minHeight: isFocused ? 116 : 54, alignment: .topLeading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: isFocused ? 28 : 30))
        .overlay(alignment: isFocused ? .bottomLeading : .leading) {
          Menu {
            if supportsAttachments {
              Button("Photo Library", systemImage: "photo.on.rectangle") { showsPhotos = true }
              Button("Choose Files", systemImage: "folder") { showsFiles = true }
            } else {
              Link("Attach files on the web", destination: attachmentURL)
            }
          } label: {
            Image(systemName: "plus")
              .font(.system(size: 22, weight: .regular))
              .frame(width: 44, height: 44)
          }
          .accessibilityLabel("Attachments")
          .disabled(isBusy || needsUpgrade)
          .padding(.leading, 8)
          .padding(.bottom, isFocused ? 8 : 0)
        }
        .overlay(alignment: isFocused ? .bottomTrailing : .trailing) {
          Button {
            Task { await submit() }
          } label: {
            Group {
              if showsProgress {
                ProgressView()
                  .controlSize(.small)
                  .tint(Color.primary)
              } else {
                Image(systemName: showsStop ? "stop.fill" : "arrow.up")
              }
            }
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(Color(uiColor: .systemBackground))
          }
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.circle)
          .controlSize(.large)
          .tint(Color.primary)
          .disabled((!hasContent && !showsStop) || !attachments.isReady || isBusy || needsUpgrade)
          .accessibilityLabel(showsStop ? "Stop" : "Send message")
          .accessibilityIdentifier(showsStop ? "stop-message" : "send-message")
          .padding(.trailing, 7)
          .padding(.bottom, isFocused ? 8 : 0)
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.22), value: isFocused)
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
    .padding(.bottom, 8)
    .background(Color(uiColor: .systemBackground))
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
