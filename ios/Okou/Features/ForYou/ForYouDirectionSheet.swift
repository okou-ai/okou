import ChatData
import SwiftUI

struct ForYouDirectionSheet: View {
  let card: ForYouCard
  @Bindable var store: ForYouStore
  let close: () -> Void
  @State private var sendTask: Task<Void, Never>?

  var body: some View {
    NavigationStack {
      if case .suggestion(let suggestion) = card.content {
        Form {
          Section {
            Text(suggestion.title).font(.okou(.headline))
            if let quote = suggestion.customOption.draft.draftUserMessage?.parts
              .first(where: { $0["type"]?.string == "feedback" })?["quote"]?.string
            {
              Text(quote).font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
            }
            ForEach(suggestion.customOption.draft.draftAttachments ?? [], id: \.id) { file in
              Label(file.filename, okouSymbol: "paperclip").font(.okou(.footnote))
            }
          }
          Section {
            TextField(
              "What would you like Okou to do?",
              text: Binding(
                get: { store.directionNotes[card.id] ?? "" },
                set: { store.directionNotes[card.id] = $0 }), axis: .vertical
            )
            .lineLimit(3...10).disabled(store.busy).accessibilityIdentifier(
              "for-you-direction-note")
          } footer: {
            Text(
              suggestion.customOption.threadId == nil
                ? "Send in a new chat" : "Send in the original chat")
          }
          if let error = store.error { Text(error).foregroundStyle(OkouColor.destructive) }
        }.navigationTitle("Your direction").navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Cancel", action: close).disabled(store.busy)
            }
            ToolbarItem(placement: .confirmationAction) {
              Button("Send") {
                let note = (store.directionNotes[card.id] ?? "").trimmingCharacters(
                  in: .whitespacesAndNewlines)
                sendTask = Task { if await store.sendDirection(card, note: note) { close() } }
              }.disabled(
                store.busy
                  || (store.directionNotes[card.id] ?? "").trimmingCharacters(
                    in: .whitespacesAndNewlines
                  ).isEmpty)
            }
          }
      }
    }.interactiveDismissDisabled(store.busy).presentationDragIndicator(.visible)
      .onDisappear { sendTask?.cancel() }
  }
}
