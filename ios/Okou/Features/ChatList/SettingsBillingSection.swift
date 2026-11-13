import CCStateSwiftUI
import ChatData
import SwiftUI

struct SettingsBillingSection: View {
  let workspace: WorkspaceStore
  @LoadableValue private var features: Loadable<SidebarFeatureSwitches>

  init(workspace: WorkspaceStore) {
    self.workspace = workspace
    _features = LoadableValue(task: workspace.settingsResources.settingsFeatures)
  }

  var body: some View {
    if features.data?.effectiveSwitches["iosSettingsBilling"] == true {
      SettingsBillingContent(workspace: workspace)
    }
  }
}

private struct SettingsBillingContent: View {
  let workspace: WorkspaceStore
  @LoadableValue private var billing: Loadable<WorkspaceBilling>

  init(workspace: WorkspaceStore) {
    self.workspace = workspace
    _billing = LoadableValue(task: workspace.settingsResources.billingValue)
  }

  var body: some View {
    Section {
      Group {
        switch billing {
        case .hasData(let status):
          OkouValueRow(value: planName(status.tier)) {
            OkouRowLabel("Current plan", okouSymbol: "layers")
          }
        case .loading:
          HStack {
            OkouRowLabel("Current plan", okouSymbol: "layers")
            Spacer(minLength: OkouSpace.sm)
            OkouSkeletonBlock(width: OkouSpace.xxxl * 2, height: OkouControl.skeletonLine)
              .okouShimmer()
              .accessibilityLabel("Loading plan")
          }
        case .hasError(let error):
          OkouLoadErrorRow(message: ChatRequestFailure.message(for: error)) {
            await workspace.refreshSettingsBilling()
          }
        }
      }
      .frame(minHeight: OkouControl.inlineActionHeight)
      .accessibilityIdentifier("settings-current-plan")
      Link(destination: workspace.billingURL) {
        OkouRowLabel("Manage billing", okouSymbol: "arrow-up-right")
      }
      .accessibilityIdentifier("settings-manage-billing")
    } header: {
      Text("Billing").okouSectionHeader()
    }
  }

  private func planName(_ tier: String) -> Text {
    switch tier {
    case "limited-free-1": Text("Free")
    case "pro": Text(verbatim: "Pro")
    case "team": Text(verbatim: "Team")
    case "custom": Text("Custom")
    default: Text(verbatim: tier)
    }
  }
}
