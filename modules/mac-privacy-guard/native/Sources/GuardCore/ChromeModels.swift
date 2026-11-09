import Foundation

public struct ChromeAgent: Decodable, Identifiable {
    public let id: String
    public let ready, reporting, protection, pending: Bool
    public let remaining, pauseRemaining: Int
}
public struct ChromeHTTPEvent: Decodable, Identifiable {
    public var id: String { profile + event }
    public let profile, session, event, host, method, mime: String
    public let status, durationMs: Int
    public let time: Double
}
public struct ChromePreview: Decodable {
    public let profile, event, text: String
}
public struct ChromeSnapshot: Decodable {
    public let agents: [ChromeAgent]
    public let events: [ChromeHTTPEvent]
    public let preview: ChromePreview?
    public let notice: String
    public static let empty = ChromeSnapshot(agents: [], events: [], preview: nil, notice: "Ожидаем связь с расширением Chrome")
}
public enum ChromeCommand: String {
    case start, stop, clear, preview
    case reportingOn = "reporting_on", reportingOff = "reporting_off"
    case pauseProtection = "pause_protection", resumeProtection = "resume_protection"
}
