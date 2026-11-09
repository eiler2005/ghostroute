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
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1150, height: 840),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "GhostRoute Guard"
        window.toolbarStyle = .unified
        window.minSize = NSSize(width: 950, height: 640)
        window.contentView = NSHostingView(rootView: GuardRootView(store: store))
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        backend.start { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let endpoint): self.store.connect(GuardClient(endpoint: endpoint))
            case .failure: self.store.startupFailed()
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
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
        app.run()
    }
}
