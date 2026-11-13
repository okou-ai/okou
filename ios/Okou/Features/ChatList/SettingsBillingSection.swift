import CCStateSwiftUI
import ChatData
import SwiftUI

struct SettingsBillingSection: View {
  let workspace: WorkspaceStore
  @LoadableValue private var billing: Loadable<WorkspaceBilling>
  @LoadableStatus<WorkspaceBilling> private var billingStatus: LoadableState

  init(workspace: WorkspaceStore) {
    self.workspace = workspace
    _billing = LoadableValue(task: workspace.settingsResources.billingValue, keepLast: true)
    _billingStatus = LoadableStatus(task: workspace.settingsResources.billingValue)
  }

  var body: some View {
    Section {
      Group {
        switch billing {
        case .hasData(let status):
          HStack(spacing: OkouSpace.sm) {
            OkouValueRow(value: planName(status.tier)) {
              OkouRowLabel("Current plan", okouSymbol: "layers")
            }
            if billingStatus == .loading {
              ProgressView().controlSize(.small).tint(OkouColor.mutedForeground)
            }
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
          OkouLoadErrorRow(
            message: ChatRequestFailure.message(for: error), isRetrying: billingStatus == .loading
          ) {
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
