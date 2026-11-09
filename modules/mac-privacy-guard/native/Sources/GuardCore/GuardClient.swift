import Foundation

private struct Failure: Decodable { let error: String }

public protocol GuardControlling {
    func status() async throws -> GuardStatus
    func activity() async throws -> GuardActivity
    func perform(_ action: GuardAction) async throws -> GuardStatus
}

public struct ControlEndpoint {
    public let baseURL: URL
    let sessionCredential: String

    public init(bootstrap: Data) throws {
        if let object = try? JSONSerialization.jsonObject(with: bootstrap) as? [String: String],
           let code = object["error"] { throw StartupFailure(rawValue: code) ?? .unexpected }
        guard let object = try JSONSerialization.jsonObject(with: bootstrap) as? [String: String],
              let text = object["url"], var parts = URLComponents(string: text),
              parts.scheme == "http", parts.host == "127.0.0.1",
              let port = parts.port, (1...65535).contains(port),
              parts.user == nil, nil == parts.password, parts.query == nil,
              parts.path == "/", let sessionCredential = parts.fragment,
              sessionCredential.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil else {
            throw ControlError.invalidEndpoint
        }
        parts.fragment = nil
        guard let url = parts.url else { throw ControlError.invalidEndpoint }
        self.baseURL = url
        self.sessionCredential = sessionCredential
    }
}

public final class GuardClient: GuardControlling {
    private let endpoint: ControlEndpoint
    private let session: URLSession

    public init(endpoint: ControlEndpoint, session: URLSession? = nil) {
        self.endpoint = endpoint
        if let session { self.session = session }
        else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.timeoutIntervalForRequest = 12
            configuration.httpShouldSetCookies = false
            configuration.connectionProxyDictionary = [:]
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration)
        }
    }

    public func status() async throws -> GuardStatus { try await request("status") }
    public func activity() async throws -> GuardActivity { try await request("activity") }
    public func perform(_ action: GuardAction) async throws -> GuardStatus {
        try await request(action.path, body: action.payload())
    }

    private func request<T: Decodable>(_ path: String, body: Data? = nil) async throws -> T {
        var request = URLRequest(url: endpoint.baseURL.appendingPathComponent("api/" + path))
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("Bearer " + endpoint.sessionCredential, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("http://127.0.0.1:\(endpoint.baseURL.port!)", forHTTPHeaderField: "Origin")
        let (data, response) = try await session.data(for: request)
        guard data.count <= 1048576, let http = response as? HTTPURLResponse else {
            throw ControlError.invalidResponse
        }
        guard http.statusCode == 200 else {
            let message = (try? JSONDecoder().decode(Failure.self, from: data).error)
                ?? "Действие не выполнено. Проверьте маршрут и профиль."
            throw ControlError.rejected(message)
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(T.self, from: data)
    }
}
