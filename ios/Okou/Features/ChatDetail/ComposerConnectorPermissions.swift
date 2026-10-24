import ChatData
import SwiftUI

struct ComposerConnectorPermissions: View {
  let store: ComposerConnectorStore
  let slug: String
  let label: String
  @State private var state: ChatConnectorPermissionState?
  @State private var search = ""
  @State private var duration = "1h"
  @State private var error: String?
  @State private var loading = false
  @State private var confirmsReset = false

  var body: some View {
    List {
      if let error { ConnectorLoadError(error: error) { await load() } }
      if loading { ProgressView("Loading permissions…") }
      if let state {
        Section {
          Picker("Allow for", selection: $duration) {
            Text("1 hour").tag("1h")
            Text("24 hours").tag("24h")
            Text("7 days").tag("7d")
            Text("Always").tag("always")
          }
          Menu("Set all listed permissions") {
            Button("Allow all") {
              Task {
                await save(
                  state.metadata.permissions.map {
                    ChatPermissionEdit(permission: $0.name, action: "allow", expiresIn: duration)
                  })
              }
            }
            Button("Deny all") {
              Task {
                await save(
                  state.metadata.permissions.map {
                    ChatPermissionEdit(permission: $0.name, action: "deny")
                  })
              }
            }
          }.disabled(store.isSaving)
        } footer: {
          Text("These permissions apply to this Agent across its conversations.")
        }
        Section("Permissions") {
          ForEach(
            state.metadata.permissions.filter {
              search.isEmpty || $0.name.localizedCaseInsensitiveContains(search)
                || $0.description?.localizedCaseInsensitiveContains(search) == true
            }, id: \.name
          ) { permission in
            permissionRow(permission.name, description: permission.description, state: state)
          }
        }
        Section("Unknown operations") {
          permissionRow(
            "__unknown__", description: "Requests not recognized by the connector", state: state)
        }
        Section {
          Button("Reset to defaults", role: .destructive) { confirmsReset = true }.disabled(
            store.isSaving)
        } footer: {
          Text(
            "Reset removes this connector's explicit grants and restores its default allow, ask, or deny rules."
          )
        }
      }
    }
    .navigationTitle(label + " permissions")
    .navigationBarTitleDisplayMode(.inline)
    .searchable(text: $search, prompt: "Find permissions")
    .task { await load() }
    .confirmationDialog(
      "Reset this connector's permissions for this Agent?", isPresented: $confirmsReset
    ) {
      Button("Reset to defaults", role: .destructive) { Task { await save([], reset: true) } }
    }
  }
  private func permissionRow(
    _ name: String, description: String?, state: ChatConnectorPermissionState
  ) -> some View {
    let policy = state.metadata.policy(for: name, grants: state.grants, at: .now)
    return HStack(alignment: .top) {
      VStack(alignment: .leading, spacing: 5) {
        Text(name == "__unknown__" ? "Unknown operations" : name).font(.callout)
        if let description { Text(description).font(.caption).foregroundStyle(.secondary) }
        if let expiry = state.grants.last(where: { $0.permission == name && $0.isActive(at: .now) }
        )?.expiresAt {
          Text("Expires \(expiry.formatted(date: .abbreviated, time: .shortened))").font(.caption)
            .foregroundStyle(.secondary)
        }
      }
      Spacer()
      Menu {
        Button("Allow") {
          Task {
            await save([ChatPermissionEdit(permission: name, action: "allow", expiresIn: duration)])
          }
        }
        Button("Deny") {
          Task { await save([ChatPermissionEdit(permission: name, action: "deny")]) }
        }
      } label: {
        Text(policy.rawValue.capitalized).frame(minHeight: 44)
      }.disabled(store.isSaving || loading)
    }
  }
  private func load() async {
    guard let agentID = store.agentID else { return }
    loading = true
    defer { loading = false }
    do {
      let result = try await store.service.permissions(slug: slug, agentID: agentID)
      guard !Task.isCancelled else { return }
      state = result
      error = nil
    } catch is CancellationError {
    } catch { self.error = error.localizedDescription }
  }
  private func save(_ edits: [ChatPermissionEdit], reset: Bool = false) async {
    guard let agentID = store.agentID else { return }
    await store.perform {
      try await store.service.savePermissions(
        slug: slug, agentID: agentID, edits: edits, reset: reset)
    }
    await load()
    if store.uncertain {
      error = store.error ?? "Refresh Connectors to confirm the saved permissions."
    }
  }
}
