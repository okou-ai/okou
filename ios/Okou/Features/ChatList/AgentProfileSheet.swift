import ChatData
import SwiftUI

/// Who does the work in this chat, laid out as a profile card: the agent, who can use it and
/// what it is for, its two actions (a new chat, editing on the web, where the full profile
/// lives), then its saved workflows. Three type sizes: 22 pt name, 15 pt supporting text,
/// 17 pt list rows.
struct AgentProfileSheet: View {
  let store: WorkspaceStore
  let agentID: String
  let newChat: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var workflows: [ComposerWorkflow] = []
  @State private var loadingWorkflows = true
  @ScaledMetric(relativeTo: .body) private var rowSlot = OkouControl.rowLeadingSlot

  private var agent: AgentRecord? {
    store.list.agents.first(where: { $0.agentId == agentID })
  }

  var body: some View {
    NavigationStack {
      List {
        Section { hero }
        Section {
          if loadingWorkflows {
            OkouLoadingRow("Loading workflows…")
          } else if workflows.isEmpty {
            Text("No saved workflows yet. When a job repeats, Okou offers to save it here.")
              .font(.okou(.subheadline)).foregroundStyle(OkouColor.mutedForeground)
          } else {
            ForEach(workflows, id: \.id) { workflow in
              workflowRow(workflow)
            }
          }
        } header: {
          Text("Workflows").okouSectionHeader()
        } footer: {
          Text("Type / in the message composer to run one.").okouSectionNote()
        }
      }
      .okouGroupedBackground()
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarTrailing) { OkouCloseButton { dismiss() } } }
      .task {
        defer { loadingWorkflows = false }
        workflows = (try? await store.composerWorkflows.load(agentID: agentID)) ?? []
      }
    }
  }

  private var hero: some View {
    VStack(spacing: OkouSpace.lg) {
      OkouAgentAvatar(
        avatarURL: agent?.avatarUrl, name: agent?.displayName ?? "Agent",
        isDefault: agent?.isDefaultAgent ?? false, size: OkouAvatarSize.profile)
      VStack(spacing: OkouSpace.sm) {
        Text(agent?.displayName ?? String(localized: "Agent"))
          .font(.okou(.title2).weight(.semibold))
          .foregroundStyle(OkouColor.foreground)
          .multilineTextAlignment(.center)
          .accessibilityAddTraits(.isHeader)
        if let visibility = agent?.visibility {
          visibilityChip(isShared: visibility == "public")
        }
        if let description = agent?.description?.trimmingCharacters(in: .whitespacesAndNewlines),
          !description.isEmpty
        {
          Text(description)
            .font(.okou(.subheadline))
            .foregroundStyle(OkouColor.mutedForeground)
            .multilineTextAlignment(.center)
            .textSelection(.enabled)
            .padding(.top, OkouSpace.xs)
        }
      }
      HStack(spacing: OkouSpace.sm) {
        Button {
          dismiss()
          newChat(agentID)
        } label: {
          OkouCompactButtonLabel("New chat", icon: "square-pen")
        }
        .buttonStyle(OkouButtonStyle(isPrimary: true, isCompact: true))
        Link(destination: store.webURL.appending(path: "agents/\(agentID)")) {
          OkouCompactButtonLabel("Edit on web", icon: "arrow-up-right")
        }
        .buttonStyle(OkouButtonStyle(isPrimary: false, isCompact: true))
      }
      .frame(maxWidth: OkouControl.emptyStateWidth)
      .padding(.top, OkouSpace.xs)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, OkouSpace.sm)
    .listRowBackground(Color.clear)
    .listRowSeparator(.hidden)
    .listRowInsets(EdgeInsets(top: 0, leading: OkouSpace.lg, bottom: 0, trailing: OkouSpace.lg))
  }

  /// Who can use the agent, as a quiet capsule rather than a loose line of small text.
  private func visibilityChip(isShared: Bool) -> some View {
    HStack(spacing: OkouSpace.six) {
      OkouIcon(isShared ? "users" : "lock", size: OkouIconSize.inline)
        .accessibilityHidden(true)
      if isShared {
        Text("Shared with the workspace")
      } else {
        Text("Only you")
      }
    }
    .font(.okou(.subheadline))
    .foregroundStyle(OkouColor.mutedForeground)
    .padding(.horizontal, OkouSpace.md)
    .frame(height: OkouControl.chipHeight - OkouSpace.xs)
    .background(OkouColor.nestedFill, in: Capsule())
    .accessibilityElement(children: .combine)
  }

  /// A workflow on the sheet's row edge: its glyph in the shared 28 pt slot, the name in body
  /// and its purpose in two supporting lines under the name.
  private func workflowRow(_ workflow: ComposerWorkflow) -> some View {
    VStack(alignment: .leading, spacing: OkouSpace.two) {
      OkouRowLabel(Text(workflow.displayName ?? workflow.name)) {
        OkouIcon("workflow", size: OkouIconSize.standard)
          .foregroundStyle(OkouColor.mutedForeground)
      }
      if let detail = workflow.description, !detail.isEmpty {
        Text(detail)
          .font(.okou(.subheadline))
          .foregroundStyle(OkouColor.mutedForeground)
          .lineLimit(2)
          .padding(.leading, rowSlot + OkouSpace.md)
      }
    }
    .padding(.vertical, OkouSpace.six)
  }
}
