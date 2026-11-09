// Dependency-free checks run with Apple Command Line Tools; full Xcode/XCTest
// is not required to install or verify the operator's local app.
import Foundation
import GuardCore
import GuardUI

enum CheckFailure: Error { case failed(String) }
func require(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw CheckFailure.failed(message) }
}
func statusData(_ state: String = "locked") -> Data {
    Data("""
    {"state":"\(state)","message":"Fixture state","route":null,"routes":[{"id":"home","kind":"https_proxy","domains":1}],"sensitive_domains":1,"connections":0,"allowed":4,"blocked":0,"errors":0,"chrome_blocked":0,"chrome_connected":false,"bytes_sent":0,"bytes_received":0,"verified_age":null}
    """.utf8)
}
func makeStatus(_ state: String) throws -> GuardStatus {
    let decoder=JSONDecoder();decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try decoder.decode(GuardStatus.self,from:statusData(state))
}

@main
struct NativeChecks {
    @MainActor static func main() async throws {
        let sessionCredential=String(repeating:"a",count:43)
        for value in ["https://example.org/#\(sessionCredential)", "http://localhost:1234/#\(sessionCredential)", "http://user:secret@127.0.0.1:1234/#\(sessionCredential)", "http://127.0.0.1:1234/?token=FAKE_PLACEHOLDER#\(sessionCredential)", "http://127.0.0.1:1234/#short"] {
            var rejected=false
            do {_ = try ControlEndpoint(bootstrap:JSONSerialization.data(withJSONObject:["url":value]))} catch {rejected=true}
            try require(rejected,"Unsafe bootstrap accepted")
        }
        let endpoint=try ControlEndpoint(bootstrap:JSONSerialization.data(withJSONObject:["url":"http://127.0.0.1:1234/#\(sessionCredential)"]))
        try require(endpoint.baseURL.fragment == nil && endpoint.baseURL.query == nil,"Credential leaked into API URL")
        let configuration=URLSessionConfiguration.ephemeral
        configuration.protocolClasses=[FixtureProtocol.self]
        let api=GuardClient(endpoint:endpoint,session:URLSession(configuration:configuration))
        FixtureProtocol.handler = { request in
            precondition(request.url?.path=="/api/status")
            precondition(request.value(forHTTPHeaderField:"Authorization")=="Bearer "+sessionCredential)
            precondition(request.value(forHTTPHeaderField:"Origin")=="http://127.0.0.1:1234")
            return (200,statusData())
        }
        let decoded=try await api.status()
        try require(decoded.state == .locked && decoded.routes.first?.kind == .httpsProxy,"Status contract did not decode")
        FixtureProtocol.handler = { request in
            precondition(request.url?.path=="/api/open")
            return (400,Data("{\"error\":\"Fixture denial\"}".utf8))
        }
        do {_ = try await api.perform(.open("https://example.org/?private=value"));throw CheckFailure.failed("Expected API rejection")}
        catch let error as ControlError {try require(error.localizedDescription=="Fixture denial","Wrong API failure")}
        print("PASS: native endpoint validation, token isolation, typed decoding and API rejection")

        let store=GuardStore(),fixture=FixtureClient()
        try require(!store.canActivate && !store.canBrowse,"Startup allowed access")
        store.connect(fixture,poll:false);await store.refresh()
        try require(store.online && store.canActivate && store.selectedRoute=="home","Closed route did not initialize")
        fixture.mode="active";await store.refresh()
        try require(store.canBrowse && store.canLock,"Active controls unavailable")
        fixture.offline=true;await store.refresh()
        try require(!store.canBrowse && !store.canActivate,"Offline UI retained active controls")
        fixture.offline=false;fixture.mode="locked";await store.refresh()
        fixture.delayActivation=true
        let activation=Task { await store.perform(.activate("home")) }
        while fixture.activation == nil { await Task.yield() }
        await store.perform(.lock)
        fixture.activation?.resume(returning:try makeStatus("active"))
        await activation.value
        try require(store.status?.state == .locked && !store.busy && !store.canBrowse,"Stale activation overwrote Lock")
        await store.perform(.clearActivity)
        try require(store.events.isEmpty && store.status?.allowed==4,"Clear reset session counters")
        await store.perform(.profile(Data("[]".utf8)))
        try require(store.error != nil && store.status?.state == .locked && !store.canBrowse,"Invalid profile opened access")
        print("PASS: native startup, route selection, offline controls, cancelled activation, clear and profile refusal")
    }
}

private final class FixtureClient: GuardControlling {
    var mode="locked",offline=false,delayActivation=false
    var activation:CheckedContinuation<GuardStatus,Error>?
    func status() async throws -> GuardStatus {if offline {throw URLError(.notConnectedToInternet)};return try makeStatus(mode)}
    func activity() async throws -> GuardActivity {try JSONDecoder().decode(GuardActivity.self,from:Data("{\"events\":[],\"capacity\":300,\"startedAt\":0}".utf8))}
    func perform(_ action:GuardAction) async throws -> GuardStatus {
        switch action {
        case .activate:
            if delayActivation {return try await withCheckedThrowingContinuation {activation=$0}}
            mode="active"
        case .lock:mode="locked"
        case .profile:throw ControlError.invalidProfile
        default:break
        }
        return try makeStatus(mode)
    }
}

private final class FixtureProtocol: URLProtocol {
    static var handler:((URLRequest)->(Int,Data))?
    override class func canInit(with request:URLRequest)->Bool {true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest {request}
    override func startLoading() {
        guard let handler=Self.handler else {return}
        let (status,data)=handler(request)
        let response=HTTPURLResponse(url:request.url!,statusCode:status,httpVersion:"HTTP/1.1",headerFields:["Content-Type":"application/json"])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:data);client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
