import Foundation

public struct ChromeAgent: Decodable, Identifiable {
    public let id: String
    public let ready, reporting, protection, pending: Bool
    public let remaining, pauseRemaining: Int
    public let desiredAllowed: Bool?
    public let strict: ChromeStrict?
    public var accessOpen: Bool { !protection && (strict?.ready ?? true) }
    public var accessChanging: Bool {
        if let strict { return strict.enabled && (["waiting", "checking"].contains(strict.reason) || (strict.ready && protection)) }
        return (desiredAllowed ?? false) == protection
    }
}
public struct ChromeStrict: Decodable {
    public let enabled, ready: Bool
    public let reason: String
    public let baseline: String?
    public var baselineMessage: String {
        baseline == "external_pac" ? "Для остальных адресов сохранены правила внешнего proxy. Это снимок: смена страны в другом расширении автоматически не подхватывается." : "Остальные сайты используют обычный сетевой путь."
    }
    public var message: String {
        ["active":"Маршрут проверен; чувствительные сайты идут через обязательный шлюз Guard.",
         "checking":"Проверяем защищённый маршрут. Запросы сайтов пока закрыты.",
         "paused":"Автоматический доступ приостановлен. Нажмите «Возобновить авто».",
         "waiting":"Настраиваем обязательный proxy Chrome; чувствительные сайты пока закрыты.",
         "conflict":"Другой компонент управляет proxy или настройками приватности Chrome. Доступ закрыт; чужие настройки не заменяются.",
         "unsupported_proxy":"Текущий proxy Chrome требует отдельного согласования. Доступ закрыт.",
         "system_proxy":"В macOS настроен proxy или его состояние неизвестно. Guard не заменяет его прямым выходом.",
         "catalog_mismatch":"Каталоги приложения и расширения различаются. Обновите расширение; доступ закрыт.",
         "route_unavailable":"Нужен один домашний HTTPS-маршрут, покрывающий чувствительный каталог и проверку выхода.",
         "route_failed":"Проверка маршрута не пройдена. Доступ закрыт; повторная проверка выполняется автоматически.",
         "permission_required":"Разрешите proxy и privacy для обновлённого расширения Chrome.",
         "upgrade_required":"Обновите и включите расширение Chrome для строгого режима."] [reason] ?? "Защищённый маршрут не подтверждён. Доступ закрыт."
    }
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
    case allowSites = "allow_sites", blockSites = "block_sites"
    case start, stop, clear, preview
    case reportingOn = "reporting_on", reportingOff = "reporting_off"
    case pauseProtection = "pause_protection", resumeProtection = "resume_protection"
}
