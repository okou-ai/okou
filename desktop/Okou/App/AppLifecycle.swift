import AppKit
import OkouCore
import Sparkle
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, SPUUpdaterDelegate {
  private var window: NSWindow!
  private var model: DesktopModel!
  private var statusItem: NSStatusItem!
  private var updaterController: SPUStandardUpdaterController?
  private var pendingUpdate: (() -> Void)?
  private var terminating = false
  private var menuRefreshPending = false
  private var lockDescriptor: Int32 = -1

  func applicationDidFinishLaunching(_ notification: Notification) {
    do {
      let configuration = try DesktopConfiguration.load()
      if CommandLine.arguments.contains("--smoke-test") {
        try smokeTest(configuration: configuration)
        NSApplication.shared.terminate(nil)
        return
      }
      model = try DesktopModel(configuration: configuration)
      lockDescriptor = open(
        model.preferences.url.deletingLastPathComponent().appendingPathComponent(
          "native-desktop.lock"
        ).path, O_CREAT | O_RDWR, 0o600)
      guard lockDescriptor >= 0, flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 else {
        throw DesktopFailure(
          "already_running", "Okou is already running. Open it from the menu bar.")
      }
      window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1024, height: 700),
        styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView], backing: .buffered,
        defer: false)
      window.title = Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "Okou"
      window.titleVisibility = .hidden
      window.titlebarAppearsTransparent = true
      window.isReleasedWhenClosed = false
      window.isMovableByWindowBackground = true
      window.collectionBehavior = [.fullScreenNone]
      window.delegate = self
      window.contentView = NSHostingView(rootView: DesktopView(model: model))
      window.center()
      showWindow()
      statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
      if let url = Bundle.main.url(forResource: "trayTemplate", withExtension: "png"),
        let image = NSImage(contentsOf: url)
      {
        image.isTemplate = true
        image.size = NSSize(width: 18, height: 18)
        statusItem.button?.image = image
      } else {
        statusItem.button?.image = NSImage(
          systemSymbolName: "circle.dotted", accessibilityDescription: "Okou")
      }
      model.didChange = { [weak self] in
        self?.scheduleMenus()
        self?.installPendingUpdateWhenIdle()
      }
      // Unsigned CI artifacts exercise startup without attempting a
      // production update; distribution artifacts use Developer ID trust.
      if Bundle.main.object(forInfoDictionaryKey: "OkouUpdatesEnabled") as? Bool == true {
        updaterController = SPUStandardUpdaterController(
          startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
      }
      scheduleMenus()
      model.start()
    } catch {
      let alert = NSAlert()
      alert.messageText = "Unable to start Okou"
      alert.informativeText = error.localizedDescription
      alert.runModal()
      NSApplication.shared.terminate(nil)
    }
  }
  private func smokeTest(configuration: DesktopConfiguration) throws {
    guard Bundle.main.bundleIdentifier != nil, configuration.product == "okou",
      FileManager.default.isExecutableFile(
        atPath: Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/computer-use-helper")
          .path),
      FileManager.default.isExecutableFile(
        atPath: Bundle.main.bundleURL.appendingPathComponent(
          "Contents/Frameworks/Squirrel.framework/Resources/ShipIt"
        ).path)
    else {
      throw DesktopFailure("invalid_package", "Native app package is incomplete")
    }
    let proof: JSONValue = .object([
      "bundleId": .string(Bundle.main.bundleIdentifier!), "native": .bool(true),
      "version": .string(
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as! String),
      "capabilities": .strings(CommandExecutor.capabilities),
    ])
    print(proof.formatted)
  }
  @objc private func showWindow() {
    NSApplication.shared.setActivationPolicy(.regular)
    window?.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
  }
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool
  {
    showWindow()
    return false
  }
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    sender.orderOut(nil)
    NSApplication.shared.setActivationPolicy(.accessory)
    return false
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard model != nil, !terminating else { return .terminateNow }
    if model.runtime.busy {
      let alert = NSAlert()
      alert.messageText = "Computer Use is running a command"
      alert.informativeText =
        "Quitting will wait for the current command to finish and report its result."
      alert.addButton(withTitle: "Quit when finished")
      alert.addButton(withTitle: "Cancel")
      if alert.runModal() != .alertFirstButtonReturn { return .terminateCancel }
    }
    terminating = true
    Task {
      await model.shutdown()
      NSApplication.shared.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
  func applicationWillTerminate(_ notification: Notification) {
    if lockDescriptor >= 0 { close(lockDescriptor) }
  }
  private func scheduleMenus() {
    guard !menuRefreshPending else { return }
    menuRefreshPending = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.menuRefreshPending = false
      self.installMenus()
    }
  }
  private func item(
    _ title: String, action: Selector? = nil, key: String = "", enabled: Bool = true
  ) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
    item.target = self
    item.isEnabled = enabled
    return item
  }
  private func installMenus() {
    guard model != nil else { return }
    let menu = NSMenu()
    menu.autoenablesItems = false
    menu.addItem(
      item(
        "Okou · \(model.online ? model.statusLabel : model.ready ? "Offline" : "Needs setup")",
        enabled: false))
    menu.addItem(.separator())
    menu.addItem(item("Open Okou", action: #selector(showWindow)))
    if !model.signedIn {
      menu.addItem(item("Sign in to Okou", action: #selector(signIn), enabled: !model.busy))
    } else if !model.online {
      menu.addItem(
        item("Switch workspace", action: #selector(switchWorkspace), enabled: !model.busy))
      menu.addItem(item("Sign out", action: #selector(signOut), enabled: !model.busy))
    }
    menu.addItem(
      item(
        model.online ? "Stop Computer Use" : "Go online", action: #selector(toggleOnline),
        enabled: !model.busy && model.ready))
    menu.addItem(
      item(
        "Refresh status", action: #selector(refreshStatus),
        enabled: !model.runtime.busy && !model.busy))
    menu.addItem(.separator())
    let awake = item("Keep this Mac awake", action: #selector(toggleAwake))
    awake.state = model.keepAwake ? .on : .off
    menu.addItem(awake)
    let permissionMenu = NSMenu()
    permissionMenu.autoenablesItems = false
    permissionMenu.addItem(item("Accessibility settings", action: #selector(accessibilitySettings)))
    permissionMenu.addItem(item("Screen Recording settings", action: #selector(screenSettings)))
    permissionMenu.addItem(
      item("Browser Automation settings", action: #selector(automationSettings)))
    let permissions = item("Permissions")
    permissions.submenu = permissionMenu
    menu.addItem(permissions)
    if !model.runtime.commands.isEmpty {
      let commands = NSMenu()
      for command in model.runtime.commands.prefix(5) {
        commands.addItem(item("\(command.kind) · \(command.status)", enabled: false))
      }
      let recent = item("Recent commands")
      recent.submenu = commands
      menu.addItem(recent)
    }
    menu.addItem(.separator())
    menu.addItem(item("Quit Okou", action: #selector(quit)))
    statusItem?.menu = menu

    let main = NSMenu()
    let app = NSMenu()
    app.autoenablesItems = false
    app.addItem(item("About Okou", action: #selector(about)))
    app.addItem(
      item(
        "Check for Updates...", action: #selector(checkForUpdates),
        enabled: updaterController?.updater.canCheckForUpdates == true))
    if model.developerToolsAvailable {
      let developer = item("Developer Tools", action: #selector(toggleDeveloper))
      developer.state = model.developerToolsEnabled ? .on : .off
      app.addItem(developer)
    }
    app.addItem(.separator())
    app.addItem(item("Quit Okou", action: #selector(quit), key: "q"))
    let application = NSMenuItem(title: "Okou", action: nil, keyEquivalent: "")
    application.submenu = app
    main.addItem(application)
    let edit = NSMenu(title: "Edit")
    for (title, selector, key) in [
      ("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"),
      ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a"),
    ] {
      edit.addItem(
        NSMenuItem(title: title, action: NSSelectorFromString(selector), keyEquivalent: key))
    }
    let editing = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    editing.submenu = edit
    main.addItem(editing)
    let windowMenu = NSMenu(title: "Window")
    windowMenu.addItem(
      NSMenuItem(
        title: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"))
    windowMenu.addItem(
      NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"))
    let windows = NSMenuItem(title: "Window", action: nil, keyEquivalent: "")
    windows.submenu = windowMenu
    main.addItem(windows)
    NSApplication.shared.mainMenu = main
  }
  @objc private func signIn() {
    showWindow()
    model.signIn()
  }
  @objc private func signOut() { model.signOut() }
  @objc private func switchWorkspace() {
    showWindow()
    model.switchWorkspace()
  }
  @objc private func toggleOnline() { model.online ? model.goOffline() : model.goOnline() }
  @objc private func refreshStatus() {
    Task {
      do { try await model.refreshPermissions() } catch { model.error = error.localizedDescription }
    }
  }
  @objc private func toggleAwake() { model.setKeepAwake(!model.keepAwake) }
  @objc private func accessibilitySettings() { model.openPermissionSettings("Accessibility") }
  @objc private func screenSettings() { model.openPermissionSettings("ScreenCapture") }
  @objc private func automationSettings() { model.openPermissionSettings("Automation") }
  @objc private func toggleDeveloper() {
    model.developerToolsEnabled.toggle()
    scheduleMenus()
  }
  @objc private func about() { NSApplication.shared.orderFrontStandardAboutPanel(nil) }
  @objc private func quit() { NSApplication.shared.terminate(nil) }
  @objc private func checkForUpdates() { updaterController?.checkForUpdates(nil) }
  func updater(
    _ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem,
    immediateInstallationBlock: @escaping () -> Void
  ) -> Bool {
    pendingUpdate = immediateInstallationBlock
    installPendingUpdateWhenIdle()
    return true
  }
  private func installPendingUpdateWhenIdle() {
    guard !terminating, !model.busy, !model.runtime.shouldDeferUpdate, let install = pendingUpdate
    else { return }
    pendingUpdate = nil
    Task {
      await model.shutdown()
      install()
    }
  }
}

@main
struct OkouApplication {
  @MainActor static func main() {
    let application = NSApplication.shared
    let delegate = AppDelegate()
    application.delegate = delegate
    application.setActivationPolicy(.regular)
    application.run()
  }
}
