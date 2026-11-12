import Foundation

/// Keep the user-requested gateway responsive while its window is in the background.
/// This assertion allows real system sleep; the engine still requalifies after wake.
public final class BackendActivity {
    private let lock = NSLock()
    private var activityHandle: NSObjectProtocol?
    private let end: (NSObjectProtocol) -> Void

    public init(
        begin: (ProcessInfo.ActivityOptions, String) -> NSObjectProtocol = {
            ProcessInfo.processInfo.beginActivity(options: $0, reason: $1)
        },
        end: @escaping (NSObjectProtocol) -> Void = { ProcessInfo.processInfo.endActivity($0) }
    ) {
        self.end = end
        activityHandle = begin(.userInitiatedAllowingIdleSystemSleep, "Maintain the user-enabled privacy gateway")
    }

    public func finish() {
        lock.lock()
        let previous = activityHandle
        activityHandle = nil
        lock.unlock()
        if let previous { end(previous) }
    }

    deinit { finish() }
}
