import AppKit
import Combine
import Foundation
import GuardCore
import UniformTypeIdentifiers

@MainActor
public final class GuardStore: ObservableObject {
    @Published public private(set) var status: GuardStatus?
    @Published public private(set) var events: [GuardEvent] = []
    @Published public private(set) var online = false
    @Published public private(set) var starting = true
    @Published public private(set) var busy = false
    @Published public var error: String?
    @Published var notice: String?
    @Published public var selectedRoute = ""
    @Published var selectedEvent: Int?
    @Published var search = ""
    @Published var filter: EventKind?
    @Published var source = "all"
    @Published var site = ""
    private var client: GuardControlling?
    private var polling: Task<Void, Never>?
    private var revision = 0

    public init() {}
    deinit { polling?.cancel() }

    public func connect(_ client: GuardControlling, poll: Bool = true) {
        self.client = client
        starting = false
        if poll {
            polling?.cancel()
            polling = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.refresh()
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                }
            }
        }
    }

    public func startupFailed() {
        starting = false
        online = false
        error = "Шлюз не запущен. Закройте другой экземпляр Guard и проверьте установку Python."
    }

    public var canActivate: Bool {
        online && !busy && status?.state == .locked && !selectedRoute.isEmpty
    }
    public var canBrowse: Bool { online && !busy && status?.state == .active }
    public var canLock: Bool { online && (status?.state != .locked || busy) }

    var visibleEvents: [GuardEvent] {
        let query = search.trimmingCharacters(in: .whitespacesAndNewlines)
        return events.filter { event in
            (filter == nil || filter == event.kind)
            && (source == "all" || event.source == source)
            && (query.isEmpty || ((event.host ?? "") + " " + event.message).localizedCaseInsensitiveContains(query))
        }
    }
    var detail: GuardEvent? { events.first { $0.id == selectedEvent } }

    public func refresh() async {
        guard !busy, let client else { return }
        let expected = revision
        do {
            async let status = client.status()
            async let activity = client.activity()
            let (newStatus, newActivity) = try await (status, activity)
            guard expected == revision else { return }
            apply(newStatus)
            events = Array(newActivity.events.prefix(300))
            if !events.contains(where: { $0.id == selectedEvent }) { selectedEvent = nil }
        } catch {
            guard expected == revision else { return }
            online = false
        }
    }

    private func apply(_ value: GuardStatus) {
        status = value
        online = true
        if value.state != .locked, let route = value.route { selectedRoute = route }
        if !value.routes.contains(where: { $0.id == selectedRoute }) {
            selectedRoute = value.routes.first?.id ?? ""
        }
    }

    public func perform(_ action: GuardAction) async {
        guard let client else { return }
        revision += 1
        let expected = revision
        busy = true
        error = nil
        notice = nil
        do {
            let result = try await client.perform(action)
            guard expected == revision else { return }
            apply(result)
            switch action {
            case .clearActivity:
                events = []; selectedEvent = nil
                notice = "Журнал очищен. Счётчики текущего запуска сохранены."
            case .extensionFolder: notice = "Папка расширения открыта в Finder."
            default: break
            }
        } catch {
            guard expected == revision else { return }
            self.error = (error as? ControlError)?.localizedDescription
                ?? "Нет связи с локальным шлюзом. Действие не подтверждено."
            online = false
        }
        guard expected == revision else { return }
        busy = false
        await refresh()
    }

    func importProfile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.message = "Импорт профиля закроет доступ и потребует новой проверки маршрута."
        panel.begin { [weak self] result in
            guard result == .OK, let url = panel.url else { return }
            do {
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 131072 else { throw ControlError.invalidProfile }
                let data = try Data(contentsOf: url)
                Task { await self?.perform(.profile(data)) }
            } catch { self?.error = "Не удалось прочитать JSON-профиль размером до 128 КБ." }
        }
    }
}
