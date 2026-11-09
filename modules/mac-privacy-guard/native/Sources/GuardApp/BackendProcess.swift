import AppKit
import Foundation
import GuardCore

final class BackendProcess {
    private var process: Process?

    func start(completion: @escaping (Result<ControlEndpoint, Error>) -> Void) {
        guard let resources = Bundle.main.resourceURL else {
            completion(.failure(ControlError.invalidEndpoint)); return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                if let previous = self.process, previous.isRunning {
                    previous.terminate()
                    previous.waitUntilExit()
                }
                let python = try String(contentsOf: resources.appendingPathComponent("python-path"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
                let child = Process(), output = Pipe()
                child.executableURL = URL(fileURLWithPath: python)
                child.arguments = ["-B", "-m", "mac_guard.app", "--parent-pid", String(ProcessInfo.processInfo.processIdentifier)]
                child.currentDirectoryURL = resources
                var environment = ProcessInfo.processInfo.environment
                environment.removeValue(forKey: "PYTHONPATH")
                environment.removeValue(forKey: "PYTHONHOME")
                for key in ["__CFBundleIdentifier", "__CFBundleMainIdentifier", "__CFBundleMainExecutablePath"] {
                    environment.removeValue(forKey: key)
                }
                environment["PYTHONNOUSERSITE"] = "1"
                child.environment = environment
                child.standardOutput = output
                child.standardError = FileHandle.nullDevice
                self.process = child
                try child.run()
                let timeout = DispatchWorkItem { if child.isRunning { child.terminate() } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 12, execute: timeout)
                defer { timeout.cancel() }
                var bytes = Data()
                while bytes.count < 2048 {
                    let part = output.fileHandleForReading.readData(ofLength: 1)
                    if part.isEmpty || part == Data([10]) { break }
                    bytes.append(part)
                }
                let endpoint = try ControlEndpoint(bootstrap: bytes)
                DispatchQueue.main.async { completion(.success(endpoint)) }
            } catch {
                if let failed = self.process, failed.isRunning { failed.terminate() }
                DispatchQueue.main.async { completion(.failure(error)) }
            }
        }
    }

    func stop() { if let process, process.isRunning { process.terminate() } }
}
