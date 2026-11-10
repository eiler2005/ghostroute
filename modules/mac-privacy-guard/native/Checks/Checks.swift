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
    {"state":"\(state)","message":"Fixture state","route":null,"routes":[{"id":"home","kind":"https_proxy","domains":1}],"sensitive_domains":1,"connections":0,"allowed":4,"blocked":0,"errors":0,"chrome_blocked":0,"chrome_allowed":7,"chrome_connected":false,"bytes_sent":0,"bytes_received":0,"verified_age":null}
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
        try require(decoded.chromeAllowed == 7 && decoded.allowed == 4,"Chrome rule matches were conflated with gateway connections")
        do {
            _ = try ControlEndpoint(bootstrap: Data("{\"error\":\"already_running\"}".utf8))
            throw CheckFailure.failed("Expected structured startup failure")
        } catch let failure as StartupFailure {
            try require(failure == .alreadyRunning,"Wrong startup diagnostic")
        }
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
        try require(store.error != nil,"API loss did not expose recovery guidance")
        fixture.offline=false;fixture.mode="locked";await store.refresh()
        try require(store.error == nil,"Recovered connection retained a stale error banner")
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

        let journal=GuardStore(),journalClient=FixtureClient()
        journalClient.includeEvents=true
        journal.startupFailed(message:"Fixture startup failure")
        try require(journal.events.first?.source=="app","Startup failure missing from native journal")
        var retried=false
        journal.retryHandler={retried=true}
        journal.retryStartup()
        try require(retried && journal.starting,"Retry did not invoke lifecycle owner")
        journal.connect(journalClient,poll:false);await journal.refresh()
        journal.filter = .allowed
        try require(journal.visibleEvents.isEmpty && journal.hiddenEventCount==2,"Hidden-event state not represented")
        journal.showBlockedEvents()
        try require(journal.visibleEvents.count==1 && journal.visibleEvents.first?.isChrome==true,"Blocked counter did not reset filters")
        journal.search="no-match";journal.source="app";journal.filter = .error
        await journal.perform(.open("https://sensitive.example.org"))
        try require(journal.filter==nil && journal.search.isEmpty && journal.source=="guard","Browser launch left a misleading filter active")
        print("PASS: startup journal/retry, hidden filters, block navigation and protected-browser launch scope")
        journal.showHelp()
        try require(journal.destination == .help,"Native help did not open")
        journal.showBlockedEvents()
        try require(journal.destination == .activity,"Blocked metric did not open journal")
        journal.showChromeEvents(.allowed)
        try require(journal.destination == .activity && journal.source == "chrome" && journal.filter == .allowed && journal.search.isEmpty,"Chrome allowed metric left stale journal filters")
        FixtureProtocol.handler = { request in
            precondition(request.url?.path == "/api/chrome/command")
            precondition(request.httpMethod == "POST")
            return (200,statusData())
        }
        _ = try await api.perform(.chromeCommand(String(repeating:"b",count:32), .pauseProtection, nil))
        FixtureProtocol.handler = { request in
            precondition(request.url?.path == "/api/chrome")
            return (200,Data("{\"agents\":[{\"id\":\"fixture\",\"ready\":true,\"reporting\":false,\"protection\":true,\"pending\":false,\"remaining\":0,\"pause_remaining\":0}],\"events\":[],\"preview\":null,\"notice\":\"Fixture agent\"}".utf8))
        }
        let chrome = try await api.chrome()
        try require(chrome.agents.first?.protection == true && chrome.agents.first?.reporting == false,"Chrome protection and reporting were conflated")
        let strictDecoder=JSONDecoder();strictDecoder.keyDecodingStrategy = .convertFromSnakeCase
        let strictAgent=try strictDecoder.decode(ChromeAgent.self,from:Data("{\"id\":\"strict-fixture\",\"ready\":false,\"reporting\":true,\"protection\":false,\"pending\":false,\"remaining\":0,\"pause_remaining\":0,\"desired_allowed\":true,\"strict\":{\"enabled\":true,\"ready\":false,\"reason\":\"conflict\"}}".utf8))
        try require(!strictAgent.accessOpen && !strictAgent.accessChanging && strictAgent.strict?.message.contains("proxy")==true,"Unverified strict state appeared protected or hid a proxy conflict")
        print("PASS: native help/navigation and independent Chrome command/status contract")
        let ordinary=GuardStore(),ordinaryClient=FixtureClient()
        ordinaryClient.includeChrome=true
        ordinary.connect(ordinaryClient,poll:false);await ordinary.refresh()
        try require(!ordinary.canBlockChrome && !ordinary.canBrowse,"Ordinary startup was not blocked")
        ordinaryClient.chromeCommandLag=2
        await ordinary.setChromeAccess(true)
        try require(ordinary.canBlockChrome && !ordinary.canBrowse && ordinary.status?.state == .locked,"Chrome access required or opened optional browser")
        try require(ordinary.chrome.agents.first?.protection == false,"Open did not follow actual Chrome acknowledgement")
        await ordinary.setChromeAccess(false)
        try require(!ordinary.canBlockChrome && ordinary.status?.state == .locked,"Close Chrome failed or changed optional gateway")
        try require(ordinary.chrome.agents.first?.protection == true,"Close did not follow actual Chrome acknowledgement")
        print("PASS: main Chrome access opens/closes independently of optional protected browser")
    }
}

private final class FixtureClient: GuardControlling {
    var mode="locked",offline=false,delayActivation=false,includeEvents=false
    var includeChrome=false,chromeAllowed=false
    var appliedChromeAllowed=false,chromeCommandLag=0,chromeReadsRemaining=0
    var activation:CheckedContinuation<GuardStatus,Error>?
    func status() async throws -> GuardStatus {if offline {throw URLError(.notConnectedToInternet)};return try makeStatus(mode)}
    func chrome() async throws -> ChromeSnapshot {
        if !includeChrome { return .empty }
        if chromeReadsRemaining>0 { chromeReadsRemaining-=1 } else { appliedChromeAllowed=chromeAllowed }
        let decoder=JSONDecoder();decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(ChromeSnapshot.self,from:Data("{\"agents\":[{\"id\":\"fixture\",\"ready\":false,\"reporting\":true,\"protection\":\(!appliedChromeAllowed),\"desired_allowed\":\(chromeAllowed),\"pending\":\(appliedChromeAllowed != chromeAllowed),\"remaining\":0,\"pause_remaining\":0}],\"events\":[],\"preview\":null,\"notice\":\"Fixture agent\"}".utf8))
    }
    func activity() async throws -> GuardActivity {
        let event = """
        {"id":1,"time":0,"kind":"blocked","source":"chrome","reason":"chrome_blocked","message":"Fixture block","host":"sensitive.example.org","route":null,"routeKind":null,"bytesSent":0,"bytesReceived":0,"state":null,"durationMs":null,"closeReason":null,"method":"GET","resourceType":"main_frame","ruleId":1}
        """
        return try JSONDecoder().decode(GuardActivity.self,from:Data("{\"events\":[\(includeEvents ? event : "")],\"capacity\":300,\"startedAt\":0}".utf8))
    }
    func perform(_ action:GuardAction) async throws -> GuardStatus {
        switch action {
        case .activate:
            if delayActivation {return try await withCheckedThrowingContinuation {activation=$0}}
            mode="active"
        case .lock:mode="locked"
        case .profile:throw ControlError.invalidProfile
        case .chromeCommand(_,let command,_):
            chromeReadsRemaining=chromeCommandLag
            if command == .allowSites { chromeAllowed=true }
            if command == .blockSites { chromeAllowed=false }
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
