import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var backend: Process?
    var allowedPort: Int?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let item = NSMenuItem()
        menu.addItem(item)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit GhostRoute Guard", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        NSApp.mainMenu = menu
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 850),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "GhostRoute Guard"
        window.minSize = NSSize(width: 480, height: 600)
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.loadHTMLString("<body style='background:#101a25;color:#f0f5fa;font:20px -apple-system;padding:40px'>GhostRoute Guard · Запуск локального шлюза…</body>", baseURL: nil)
        DispatchQueue.global(qos: .userInitiated).async { self.launchBackend() }
    }

    func launchBackend() {
        guard let resources = Bundle.main.resourceURL else { return }
        do {
            let python = try String(contentsOf: resources.appendingPathComponent("python-path"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            let process = Process()
            let output = Pipe()
            process.executableURL = URL(fileURLWithPath: python)
            process.arguments = ["-B", "-m", "mac_guard.app", "--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]
            process.currentDirectoryURL = resources
            var environment = ProcessInfo.processInfo.environment
            // Do not accept injected Python modules or interpreter customization.
            environment.removeValue(forKey: "PYTHONPATH")
            environment.removeValue(forKey: "PYTHONHOME")
            environment["PYTHONNOUSERSITE"] = "1"
            process.environment = environment
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            self.backend = process
            try process.run()
            var bytes = Data()
            while bytes.count < 2048 {
                let part = output.fileHandleForReading.readData(ofLength: 1)
                if part.isEmpty || part == Data([10]) { break }
                bytes.append(part)
            }
            guard let object = try JSONSerialization.jsonObject(with: bytes) as? [String: String],
                  let text = object["url"], let url = URL(string: text),
                  url.host == "127.0.0.1", url.scheme == "http", let port = url.port else {
                throw NSError(domain: "Guard", code: 1)
            }
            DispatchQueue.main.async {
                self.allowedPort = port
                self.web.load(URLRequest(url: url))
            }
        } catch {
            DispatchQueue.main.async {
                self.web.loadHTMLString("<body style='background:#101a25;color:#f0f5fa;font:18px -apple-system;padding:40px'>Шлюз не запущен. Закройте другой экземпляр Guard и проверьте установку Python по инструкции модуля. Защищённый браузер не открывается.</body>", baseURL: nil)
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           (url.scheme == "about" || (url.scheme == "http" && url.host == "127.0.0.1" && url.port == allowedPort)) {
            decisionHandler(.allow)
        } else { decisionHandler(.cancel) }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) {
        if let process = backend, process.isRunning { process.terminate() }
    }
    func application(_ sender: NSApplication, open urls: [URL]) {
        // Launch only; never forward an untrusted URL into the protected browser.
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
