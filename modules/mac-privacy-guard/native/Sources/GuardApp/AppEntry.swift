import AppKit
import SwiftUI
import GuardCore
import GuardUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let store = GuardStore()
    private let backend = BackendProcess()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if activateExistingInstance() { NSApp.terminate(nil); return }
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"), let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
        }
        let menu = NSMenu(), appItem = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle: "О GhostRoute Guard", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Закрыть GhostRoute Guard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem)
        let edit = NSMenuItem(), editMenu = NSMenu(title: "Правка")
        for (title, action, key) in [("Отменить", Selector(("undo:")), "z"), ("Вырезать", #selector(NSText.cut(_:)), "x"), ("Копировать", #selector(NSText.copy(_:)), "c"), ("Вставить", #selector(NSText.paste(_:)), "v"), ("Выбрать всё", #selector(NSText.selectAll(_:)), "a")] {
            editMenu.addItem(withTitle: title, action: action, keyEquivalent: key)
        }
        edit.submenu = editMenu; menu.addItem(edit)
        let helpItem = NSMenuItem(), helpMenu = NSMenu(title: "Справка")
        let helpAction = helpMenu.addItem(withTitle: "Справка GhostRoute Guard", action: #selector(showHelp), keyEquivalent: "?")
        helpAction.target = self
        helpItem.submenu = helpMenu; menu.addItem(helpItem); NSApp.helpMenu = helpMenu
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "GhostRoute Guard"
        window.toolbarStyle = .unified
        window.minSize = NSSize(width: 820, height: 620)
        window.contentView = NSHostingView(rootView: GuardRootView(store: store))
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        store.retryHandler = { [weak self] in self?.startBackend() }
        startBackend()
    }

    @objc private func showHelp() { store.showHelp(); window?.makeKeyAndOrderFront(nil) }

    private func activateExistingInstance() -> Bool {
        let current = ProcessInfo.processInfo.processIdentifier
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: "org.ghostroute.guard")
            .filter { $0.processIdentifier != current && !$0.isTerminated }
            .sorted { ($0.launchDate ?? Date.distantFuture) < ($1.launchDate ?? Date.distantFuture) }
        guard let existing = others.first else { return false }
        return existing.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    }

    private func startBackend() {
        backend.start { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let endpoint): self.store.connect(GuardClient(endpoint: endpoint))
            case .failure(let error):
                if let failure = error as? StartupFailure, failure == .alreadyRunning,
                   self.activateExistingInstance() { NSApp.terminate(nil); return }
                self.store.startupFailed(message: (error as? StartupFailure)?.localizedDescription ?? StartupFailure.unexpected.localizedDescription)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.deminiaturize(nil)
        window?.makeKeyAndOrderFront(nil)
        sender.activate(ignoringOtherApps: true)
        return true
    }
    func applicationWillTerminate(_ notification: Notification) { backend.stop() }
    func application(_ sender: NSApplication, open urls: [URL]) {
        // Custom URL launch only focuses the app. It cannot open access or URLs.
        window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
}

@main
struct GuardApplication {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        withExtendedLifetime(delegate) { app.run() }
    }
}
