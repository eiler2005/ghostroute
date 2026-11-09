import SwiftUI
import GuardCore

struct SettingsView: View {
    @ObservedObject var store: GuardStore
    var body: some View {
        Form {
            SwiftUI.Section("Маршруты и профиль") {
                LabeledContent("Чувствительных доменов", value: "\(store.status?.sensitiveDomains ?? 0)")
                LabeledContent("Настроено маршрутов", value: "\(store.status?.routes.count ?? 0)")
                Button("Импортировать JSON-профиль…") { store.importProfile() }.disabled(store.busy)
                Text("Импорт закрывает доступ и требует повторной проверки. Адреса и пароли хранятся только на этом Mac.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            SwiftUI.Section("Связь с обычным Google Chrome") {
                LabeledContent("Блокировщик") {
                    Label(store.online && store.status?.chromeConnected == true ? "На связи" : "Нет свежего сигнала", systemImage: store.status?.chromeConnected == true ? "checkmark.circle" : "minus.circle")
                        .foregroundStyle(store.online && store.status?.chromeConnected == true ? Color.green : Color.secondary)
                }
                LabeledContent("Доставлено блокировок за запуск", value: "\(store.status?.chromeBlocked ?? 0)")
                Text("Расширение блокирует чувствительные сайты в обычном Chrome и сообщает собственные срабатывания. Включается отдельно в каждом профиле; один сигнал не подтверждает защиту всех профилей.")
                    .font(.callout).foregroundStyle(.secondary)
                Button { Task { await store.perform(.extensionFolder) } } label: {
                    Label("Показать папку расширения", systemImage: "folder")
                }.disabled(!store.online || store.busy)
                Text("chrome://extensions → режим разработчика → загрузить распакованное расширение. После обновления нажмите «Перезагрузить» и примите новые разрешения, если Chrome их запросит.")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            SwiftUI.Section("Область защиты") {
                Label("Защищённый браузер", systemImage: "checkmark.shield")
                Text("«Открыть доступ» разрешает соединения только через проверенный шлюз Guard. Обычный Chrome продолжает блокировать чувствительные сайты.")
                Label("Локальный журнал", systemImage: "list.bullet.rectangle")
                Text("Последние 300 событий находятся только в памяти. Полные URL, параметры, содержимое страниц, пароли и cookies не собираются. Передача учитывается только внутри туннелей Guard.")
                Label("Системный фильтр", systemImage: "network.badge.shield.half.filled")
                Text("Фильтр всего Mac в этой версии не установлен. Архитектура допускает отдельный адаптер Network Extension после подписи и приёмки. Другие приложения Mac сейчас не охвачены.")
            }.font(.callout)
        }.formStyle(.grouped)
    }
}
