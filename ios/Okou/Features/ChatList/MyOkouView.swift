import SwiftUI

struct MyOkouView: View {
  @Bindable var store: PersonalInstructionsStore
  let workspaceName: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: OkouSpace.lg) {
          HStack(spacing: OkouSpace.md) {
            OkouAgentAvatar(
              avatarURL: nil, name: "Okou", isDefault: true, size: OkouAvatarSize.greeting
            )
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: OkouSpace.xs) {
              Text("Your instructions for Okou in this workspace").font(.okou(.subheadline))
              Text(workspaceName).font(.okou(.caption)).foregroundStyle(OkouColor.mutedForeground)
            }
          }
          if store.isLoading {
            OkouLoadingRow("Loading instructions…")
          } else if store.saved != nil {
            Text("Instructions").font(.okou(.headline))
            TextEditor(text: Binding(get: { store.content }, set: { store.edit($0) }))
              .font(.okou(.body))
              .frame(minHeight: 300)
              .padding(OkouSpace.sm)
              .scrollContentBackground(.hidden)
              .modifier(OkouSurfaceStyle(radius: OkouRadius.control))
              .disabled(store.isSaving)
              .accessibilityLabel("Instructions")
              .accessibilityIdentifier("personal-instructions-editor")
            Text("Write in plain text or use Markdown").font(.okou(.footnote)).foregroundStyle(
              OkouColor.mutedForeground)
          }
          Text("Used the next time Okou starts working. Work in progress won’t change.")
            .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
          if let error = store.error {
            OkouLoadErrorRow(
              message: error, actionTitle: "Retry", isRetrying: store.isSaving || store.isLoading
            ) {
              if store.saved == nil {
                await store.load()
              } else if store.conflict {
                await store.discard()
              } else {
                await store.save()
              }
            }
          }
          if store.conflict {
            Text(
              "Your saved instructions changed elsewhere. Your draft is kept. Review or copy it before reloading."
            )
            .font(.okou(.footnote))
            Button("Reload saved instructions") { Task { await store.discard() } }
              .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
          }
          if store.saved != nil && !store.isDirty && !store.isLoading && !store.isSaving
            && store.error == nil
          {
            Text("Instructions saved").font(.okou(.footnote)).foregroundStyle(
              OkouColor.mutedForeground)
          }
          if store.isDirty {
            Text("Your draft is kept on this device when you close this page or switch workspaces.")
              .font(.okou(.footnote)).foregroundStyle(OkouColor.mutedForeground)
          }
        }
        .padding(OkouSpace.xl)
      }
      .scrollDismissesKeyboard(.interactively)
      .safeAreaInset(edge: .bottom) {
        if store.isDirty || store.isSaving {
          VStack(alignment: .leading, spacing: OkouSpace.sm) {
            Text("Unsaved changes").font(.okou(.footnote))
            HStack {
              Button("Discard", role: .destructive) { Task { await store.discard() } }
                .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
                .disabled(store.isSaving)
              Button(store.isSaving ? "Saving…" : "Save") { Task { await store.save() } }
                .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
                .disabled(store.isSaving || store.isLoading || store.conflict)
            }
          }
          .padding(OkouSpace.lg)
          .background(.bar)
        }
      }
      .background(OkouColor.background)
      .foregroundStyle(OkouColor.foreground)
      .navigationTitle("My Okou")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { OkouCloseToolbarItem { dismiss() } }
      .task { await store.load() }
    }
    .interactiveDismissDisabled(store.isSaving)
  }
}

extension EnvironmentValues {
  @Entry var singleAgentExperience = false
}
