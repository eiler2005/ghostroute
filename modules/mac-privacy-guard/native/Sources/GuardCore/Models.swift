import Foundation

public enum AccessState: String, Decodable { case locked, qualifying, active }
public enum RouteKind: String, Decodable { case httpsProxy = "https_proxy", boundVPN = "bound_vpn" }
public enum EventKind: String, Decodable, CaseIterable { case allowed, blocked, error, system }

public struct GuardRoute: Decodable, Identifiable, Equatable {
    public let id: String
    public let kind: RouteKind
    public let domains: Int
    public var title: String { kind == .httpsProxy ? "Домашний маршрут" : "Сторонний VPN" }
}

public struct GuardStatus: Decodable, Equatable {
    public let state: AccessState
    public let message: String
    public let route: String?
    public let routes: [GuardRoute]
    public let sensitiveDomains, connections, allowed, blocked, errors: Int
    public let chromeBlocked: Int
    public let chromeConnected: Bool
    public let bytesSent, bytesReceived: Int64
    public let verifiedAge: Int?
}

public struct GuardEvent: Decodable, Identifiable, Equatable {
    public let id: Int
    public let time: Double
    public let kind: EventKind
    public let source, reason, message: String
    public let host, route: String?
    public let routeKind: RouteKind?
    public let bytesSent, bytesReceived: Int64
    public let state: String?
    public let durationMs: Int?
    public let closeReason, method, resourceType: String?
    public let ruleId: Int?
    public var date: Date { Date(timeIntervalSince1970: time) }
    public var isChrome: Bool { source == "chrome" }
}

public struct GuardActivity: Decodable {
    public let events: [GuardEvent]
    public let capacity: Int
    public let startedAt: Double
}

public enum GuardAction {
    case activate(String), lock, open(String), profile(Data), clearActivity, extensionFolder

    var path: String {
        switch self {
        case .activate: return "activate"
        case .lock: return "lock"
        case .open: return "open"
        case .profile: return "profile"
        case .clearActivity: return "activity/clear"
        case .extensionFolder: return "extension-folder"
        }
    }

    func payload() throws -> Data {
        var value: [String: Any] = [:]
        switch self {
        case .activate(let route): value["route"] = route
        case .open(let url): value["url"] = url
        case .profile(let data):
            guard data.count <= 131072,
                  let profile = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw ControlError.invalidProfile
            }
            value["profile"] = profile
        default: break
        }
        return try JSONSerialization.data(withJSONObject: value)
    }
}

public enum ControlError: LocalizedError {
    case invalidEndpoint, invalidResponse, invalidProfile, rejected(String)
    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint: return "Локальный шлюз не передал корректный адрес управления."
        case .invalidResponse: return "Ответ локального шлюза не удалось проверить."
        case .invalidProfile: return "Нужен JSON-профиль размером не больше 128 КБ."
        case .rejected(let message): return message
        }
    }
}
