import AppKit
import OkouCore
import SwiftUI

private let foreground = Color(red: 0.149, green: 0.133, blue: 0.114)
private let muted = Color(red: 0.40, green: 0.44, blue: 0.52)
private let brand = Color(red: 1, green: 0.647, blue: 0)

struct DesktopView: View {
  @Environment(\.displayScale) private var displayScale
  @ObservedObject var model: DesktopModel
  var body: some View {
    VStack(spacing: 0) {
      Color(nsColor: .windowBackgroundColor).frame(height: 4)
        .overlay(alignment: .bottom) {
          Rectangle().fill(foreground.opacity(0.1)).frame(height: 1 / displayScale)
        }
      Group {
        if model.preparing {
          VStack(spacing: 18) {
            BrandImage(name: "symbol").frame(width: 92, height: 92)
            ProgressView().controlSize(.small)
            Text("Preparing").font(.system(size: 18, weight: .semibold))
          }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          GeometryReader { geometry in
            ScrollView {
              VStack(spacing: 16) {
                if model.ready {
                  hero.frame(
                    height: model.developerToolsEnabled ? 370 : max(628, geometry.size.height - 20))
                } else {
                  accountCard
                  permissionCard
                }
                if let error = model.error ?? model.runtime.lastError {
                  HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.circle")
                    Text(error).frame(maxWidth: .infinity, alignment: .leading)
                    Button("Details") { model.showDiagnostics = true }
                  }.font(.system(size: 13)).padding(10)
                    .foregroundStyle(Color(red: 0.57, green: 0.25, blue: 0.05))
                    .background(
                      Color(red: 1, green: 0.984, blue: 0.922),
                      in: RoundedRectangle(cornerRadius: 7))
                }
                if model.developerToolsAvailable && model.developerToolsEnabled {
                  runtimePanel
                  commandPanel
                }
              }
              .padding(.horizontal, 20).padding(.top, 20)
              .padding(.bottom, model.ready ? 0 : 20)
              .frame(
                minHeight: model.ready && !model.developerToolsEnabled ? geometry.size.height : 0,
                alignment: .top)
            }
          }
        }
      }
      .background(
        LinearGradient(
          colors: [
            Color(red: 0.998, green: 0.997, blue: 0.996),
            Color(red: 0.980, green: 0.961, blue: 0.953),
          ], startPoint: .top, endPoint: .bottom)
      )
    }
    .font(.system(size: 14)).foregroundStyle(foreground)
    .preferredColorScheme(.light)
    .sheet(isPresented: $model.showWorkspaces) { workspacePicker }
    .sheet(isPresented: $model.showDiagnostics) { diagnostics }
  }
  private var accountCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      kicker(1, "Account", ready: model.signedIn && model.organization != nil)
      if model.signedIn, let organization = model.organization {
        HStack {
          VStack(alignment: .leading, spacing: 3) {
            Text(model.email).fontWeight(.semibold)
            Text(organization).foregroundStyle(muted).font(.system(size: 12))
          }
          Spacer()
          Button("Switch workspace") { model.switchWorkspace() }
          Button("Sign out") { model.signOut() }
        }
      } else {
        Text(
          model.signedIn
            ? "Select a workspace" : model.busy ? "Finish signing in" : "Sign in to Okou"
        ).font(.system(size: 24, weight: .semibold))
        Text(
          model.signedIn
            ? "Choose the workspace that should receive this Mac as a Computer Use runtime."
            : "Connect this Mac to an Okou account before Computer Use can register a runtime."
        )
        .foregroundStyle(muted).font(.system(size: 14)).lineSpacing(3)
        Button {
          model.signedIn ? model.switchWorkspace() : model.signIn()
        } label: {
          Label(
            model.signedIn ? "Select workspace" : "Sign in",
            systemImage: model.signedIn ? "building.2" : "arrow.up.right.square")
        }.buttonStyle(BrandButtonStyle()).disabled(model.busy)
      }
    }.padding(18).frame(maxWidth: .infinity, alignment: .leading).card()
  }
  private var permissionCard: some View {
    VStack(alignment: .leading, spacing: 12) {
      kicker(2, "Permissions", ready: model.permissionsReady)
      Text("Allow Computer Use on this Mac").font(.system(size: 24, weight: .semibold))
      Text("Grant Accessibility and Screen Recording so Okou can inspect and control app windows.")
        .foregroundStyle(muted)
      permissionRow(
        title: "Accessibility", subtitle: "Read and interact with app controls.",
        granted: model.permissions["accessibility"].bool == true, screen: false)
      permissionRow(
        title: "Screen Recording", subtitle: "Capture the app window for Computer Use.",
        granted: model.permissions["screenRecording"].bool == true, screen: true)
      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Text("Browser Automation").fontWeight(.semibold)
          Text("Optional for browser control. Test only the browser you use.").font(
            .system(size: 12)
          ).foregroundStyle(muted)
        }
        Spacer()
        ForEach(["chrome", "safari"], id: \.self) { browser in
          VStack(spacing: 3) {
            Button("Test " + browser.capitalized) { model.probeBrowser(browser) }
            if let status = model.browserPermissions[browser]?["status"].string {
              Text(status.replacingOccurrences(of: "_", with: " ")).font(.system(size: 10))
                .foregroundStyle(muted)
            }
          }
        }
        Button("Settings") { model.openPermissionSettings("Automation") }
      }.permissionRow()
      HStack {
        Toggle(isOn: Binding(get: { model.keepAwake }, set: { model.setKeepAwake($0) })) {
          VStack(alignment: .leading, spacing: 3) {
            Text("Keep this Mac awake").fontWeight(.semibold)
            Text("Prevent display sleep while Okou is running.").font(.system(size: 12))
              .foregroundStyle(muted)
          }
        }.toggleStyle(.checkbox)
        Spacer()
        Text(model.keepAwake ? "Active" : "Off").font(.system(size: 12)).foregroundStyle(muted)
      }.permissionRow()
    }.padding(18).frame(maxWidth: .infinity, alignment: .leading).card()
      .disabled(!model.signedIn || model.organization == nil || model.busy).opacity(
        model.signedIn && model.organization != nil ? 1 : 0.65)
  }
  private func permissionRow(title: String, subtitle: String, granted: Bool, screen: Bool)
    -> some View
  {
    HStack {
      VStack(alignment: .leading, spacing: 3) {
        Text(title).fontWeight(.semibold)
        Text(subtitle).font(.system(size: 12)).foregroundStyle(muted)
      }
      Spacer()
      Label(
        granted ? "Granted" : "Required",
        systemImage: granted ? "checkmark" : "exclamationmark.circle"
      )
      .font(.system(size: 12, weight: .semibold)).padding(.horizontal, 9).padding(.vertical, 5)
      .foregroundStyle(granted ? Color.green : Color.orange)
      .background(granted ? Color.green.opacity(0.08) : Color.orange.opacity(0.08), in: Capsule())
      if !granted { Button("Allow") { model.requestPermission(screenRecording: screen) } }
      Button("Open settings") {
        model.openPermissionSettings(screen ? "ScreenCapture" : "Accessibility")
      }
    }.permissionRow()
  }
  private var hero: some View {
    VStack(spacing: 0) {
      VStack(spacing: 0) {
        if model.online {
          Radar().frame(width: 240, height: 240)
        } else {
          BrandImage(name: "symbol").frame(width: 108, height: 108)
            .background(
              Color(red: 0.980, green: 0.961, blue: 0.953), in: RoundedRectangle(cornerRadius: 26)
            )
            .overlay {
              RoundedRectangle(cornerRadius: 26).stroke(foreground.opacity(0.08), lineWidth: 1)
            }
            .opacity(0.62).padding(.bottom, 24)
        }
        Text(model.online ? model.deviceName : "Offline").font(.system(size: 17, weight: .semibold))
          .padding(.top, model.online ? 24 : 0)
          .foregroundStyle(model.online ? foreground : muted)
        if model.online {
          HStack(spacing: 6) {
            Circle().fill(model.runtime.status == "online" ? Color.green : brand).frame(
              width: 7, height: 7)
            Text(model.statusLabel)
          }
          .font(.system(size: 12.5)).foregroundStyle(Color(red: 0.604, green: 0.639, blue: 0.686))
          .padding(.top, 6)
        } else {
          Button {
            model.goOnline()
          } label: {
            Label("Go online", systemImage: "play.fill")
          }
          .buttonStyle(GoOnlineButtonStyle()).padding(.top, 22).disabled(
            model.busy || model.runtime.status == "disabled")
        }
      }.frame(maxWidth: .infinity, maxHeight: .infinity)
      HStack {
        if !model.online {
          Circle().fill(model.permissionsReady ? Color.green : brand).frame(width: 7, height: 7)
        }
        Text(model.email + (model.organization.map { " · " + $0 } ?? "")).font(.system(size: 12))
          .foregroundStyle(Color(red: 0.604, green: 0.639, blue: 0.686)).lineLimit(1)
        Spacer()
        Menu {
          if model.online {
            Button("Stop", role: .destructive) { model.goOffline() }
          } else {
            Button("Switch workspace") { model.switchWorkspace() }
            Button("Sign out", role: .destructive) { model.signOut() }
          }
        } label: {
          Image(systemName: "ellipsis").frame(width: 26, height: 26)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().disabled(model.busy)
      }.frame(height: 52).overlay(alignment: .top) {
        Rectangle().fill(foreground.opacity(0.08)).frame(height: 1)
      }
    }
  }
  private var runtimePanel: some View {
    VStack(alignment: .leading, spacing: 14) {
      Label("Runtime", systemImage: "desktopcomputer").fontWeight(.semibold)
      HStack {
        runtimeCell("Status", model.statusLabel)
        runtimeCell("Host ID", model.runtime.hostId ?? "Not registered")
        runtimeCell(
          "Last heartbeat",
          model.runtime.lastHeartbeat?.formatted(date: .omitted, time: .standard) ?? "Never")
        runtimeCell(
          "Last command",
          model.runtime.lastCommand?.formatted(date: .omitted, time: .standard) ?? "Never")
      }
      HStack {
        Toggle(
          "Keep this Mac awake",
          isOn: Binding(get: { model.keepAwake }, set: { model.setKeepAwake($0) })
        ).toggleStyle(.checkbox)
        Spacer()
        Button("Refresh status") { Task { try? await model.refreshPermissions() } }
        Button("Error details") { model.showDiagnostics = true }
      }
    }.padding(18).card()
  }
  private func runtimeCell(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(label).font(.system(size: 12)).foregroundStyle(muted)
      Text(value).font(.system(size: 13, weight: .semibold)).lineLimit(1).textSelection(.enabled)
    }
    .padding(12).frame(maxWidth: .infinity, alignment: .leading).background(
      Color(red: 0.973, green: 0.980, blue: 0.988), in: RoundedRectangle(cornerRadius: 7))
  }
  private var commandPanel: some View {
    VStack(alignment: .leading, spacing: 14) {
      Label("Command Log", systemImage: "list.bullet.rectangle").fontWeight(.semibold)
      if model.runtime.commands.isEmpty {
        Text("No commands yet.").foregroundStyle(muted).font(.system(size: 13))
      }
      ForEach(model.runtime.commands) { command in
        DisclosureGroup {
          VStack(alignment: .leading, spacing: 8) {
            Text("Payload").fontWeight(.semibold)
            Text(command.payload.formatted).font(.system(size: 12, design: .monospaced))
              .textSelection(.enabled)
            if let response = command.response {
              Text("Result").fontWeight(.semibold)
              Text(response.formatted).font(.system(size: 12, design: .monospaced)).textSelection(
                .enabled)
              if let screenshot = response["result"]["screenshot"].string,
                let data = Data(
                  base64Encoded: String(screenshot.split(separator: ",", maxSplits: 1).last ?? "")),
                let image = NSImage(data: data)
              {
                Image(nsImage: image).resizable().scaledToFit().frame(maxHeight: 250)
              }
            }
          }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
        } label: {
          HStack {
            Text(command.kind).fontWeight(.semibold)
            Text(command.payload["app"].string ?? "").foregroundStyle(muted)
            Spacer()
            Text(command.status.capitalized).foregroundStyle(
              command.status == "failed" ? .red : .green)
            Text(command.startedAt.formatted(date: .omitted, time: .standard)).foregroundStyle(
              muted)
          }.font(.system(size: 12))
        }
      }
    }.padding(18).frame(maxWidth: .infinity, alignment: .leading).card()
  }
  private var workspacePicker: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Select a workspace").font(.title2.bold())
      if model.organizations.isEmpty {
        Text("No workspace memberships were found. Join a workspace in Okou, then try again.")
      }
      ForEach(model.organizations, id: \.id) { org in
        Button(org.name) { model.chooseWorkspace(org.id) }.frame(
          maxWidth: .infinity, alignment: .leading)
      }
      Button("Cancel") { model.showWorkspaces = false }
    }.padding(24).frame(width: 420).disabled(model.busy)
  }
  private var diagnostics: some View {
    VStack(alignment: .leading, spacing: 16) {
      HStack {
        Text("Error details").font(.title2.bold())
        Spacer()
        Button("Close") { model.showDiagnostics = false }
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Text("Local Computer Use runtime diagnostics").foregroundStyle(muted)
          Text(
            "Status: \(model.statusLabel)\nHost ID: \(model.runtime.hostId ?? "Not registered")\nRecovery attempt: \(model.runtime.recoveryAttempt)"
          )
          Text("Latest error").fontWeight(.semibold)
          Text(model.error ?? model.runtime.lastError ?? "No errors captured.")
          Text("Recent error log").fontWeight(.semibold)
          ForEach(Array(model.runtime.errors.enumerated()), id: \.offset) { _, error in
            Text(error).font(.system(size: 12, design: .monospaced))
          }
        }.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
      }
    }.padding(24).frame(width: 640, height: 420)
  }
  private func kicker(_ number: Int, _ label: String, ready: Bool) -> some View {
    HStack(spacing: 9) {
      ZStack {
        Circle().fill(ready ? Color.green : brand)
        Text(ready ? "✓" : "\(number)").font(.system(size: 12, weight: .bold)).foregroundStyle(
          ready ? .white : foreground)
      }.frame(width: 24, height: 24)
      Text(label).font(.system(size: 12, weight: .semibold)).foregroundStyle(muted)
    }
  }
}

private struct BrandImage: View {
  let name: String
  var body: some View {
    if let url = Bundle.main.url(forResource: name, withExtension: "png"),
      let image = NSImage(contentsOf: url)
    {
      Image(nsImage: image).resizable().scaledToFit().accessibilityHidden(true)
    }
  }
}
private struct Radar: View {
  @State private var pulse = false
  var body: some View {
    ZStack {
      Circle().fill(
        RadialGradient(
          colors: [brand.opacity(0.2), brand.opacity(0.09), .clear], center: .center,
          startRadius: 0, endRadius: 110)
      ).frame(width: 220, height: 220).blur(radius: 14)
      ForEach(0..<3) { index in
        Circle().stroke(brand.opacity([0.42, 0.20, 0.09][index]), lineWidth: 1.5)
          .frame(width: CGFloat(118 + index * 48), height: CGFloat(118 + index * 48))
          .scaleEffect(pulse ? 1.035 : 1)
      }
      BrandImage(name: "symbol").frame(width: 104, height: 104).scaleEffect(pulse ? 1.03 : 1)
    }.onAppear {
      withAnimation(.easeInOut(duration: 3.4).repeatForever(autoreverses: true)) { pulse = true }
    }
  }
}
private struct BrandButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.system(size: 13, weight: .semibold)).padding(.horizontal, 14).padding(
      .vertical, 10
    )
    .foregroundStyle(foreground).background(
      configuration.isPressed ? brand.opacity(0.8) : brand, in: RoundedRectangle(cornerRadius: 7))
  }
}
private struct GoOnlineButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.font(.system(size: 13, weight: .semibold)).padding(.horizontal, 22).frame(
      height: 40
    )
    .foregroundStyle(foreground).background(
      configuration.isPressed ? brand.opacity(0.8) : brand, in: RoundedRectangle(cornerRadius: 11)
    )
    .shadow(color: brand.opacity(0.4), radius: 9, y: 4)
  }
}
extension View {
  fileprivate func card() -> some View {
    background(.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 9)).overlay {
      RoundedRectangle(cornerRadius: 9).stroke(foreground.opacity(0.08), lineWidth: 1)
    }
  }
  fileprivate func permissionRow() -> some View {
    padding(10).frame(minHeight: 58).background(
      Color(red: 0.977, green: 0.980, blue: 0.984), in: RoundedRectangle(cornerRadius: 7)
    ).overlay { RoundedRectangle(cornerRadius: 7).stroke(foreground.opacity(0.08), lineWidth: 1) }
  }
}
