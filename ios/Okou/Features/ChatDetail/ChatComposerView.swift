import SwiftUI

struct ChatComposerView: View {
  @Binding var draft: String
  let isBusy: Bool
  let showsProgress: Bool
  let canStop: Bool
  let needsUpgrade: Bool
  let error: String?
  let attachmentURL: URL
  let submit: @MainActor () async -> Void
  let refresh: (@MainActor () async -> Void)?

  @FocusState private var isFocused: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  private var hasText: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  private var showsStop: Bool { canStop && !hasText }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
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
            Link("Attach files on the web", destination: attachmentURL)
          } label: {
            Image(systemName: "plus")
              .font(.system(size: 22, weight: .regular))
              .frame(width: 44, height: 44)
          }
          .accessibilityLabel("Attachments")
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
              } else {
                Image(systemName: showsStop ? "stop.fill" : "arrow.up")
              }
            }
            .font(.system(size: 18, weight: .semibold))
            .frame(width: 42, height: 42)
            .foregroundStyle(Color(uiColor: .systemBackground))
            .background(Color.primary.opacity((hasText || showsStop) ? 1 : 0.38), in: Circle())
          }
          .disabled((!hasText && !showsStop) || isBusy || needsUpgrade)
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
  }
}
