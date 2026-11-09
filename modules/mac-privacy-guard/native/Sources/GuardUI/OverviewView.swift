import SwiftUI
import GuardCore

struct OverviewView: View {
    @ObservedObject var store: GuardStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                AccessView(store: store)
                GroupBox {
                    HStack(spacing: 12) {
                        Image(systemName: "globe").font(.title2).foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Защищённый браузер").font(.headline)
                            Text("Сайт нужно открыть этой кнопкой").font(.caption).foregroundStyle(.secondary)
                        }
                        TextField("example.org или HTTPS-адрес", text: $store.site)
                            .textFieldStyle(.roundedBorder)
                            .onSubmit { if store.canBrowse && !store.site.isEmpty { Task { await store.perform(.open(store.site)) } } }
                        Button("Открыть в Guard") { Task { await store.perform(.open(store.site)) } }
                            .disabled(!store.canBrowse || store.site.trimmingCharacters(in: .whitespaces).isEmpty)
                            .help("Открывает отдельный Chrome «GhostRoute Guard», а не обычный профиль")
                    }.padding(8)
                }
                HStack(spacing: 12) {
                    MetricView(title: "Разрешено", value: "\(store.status?.allowed ?? 0)", detail: "Соединений через Guard", icon: "checkmark.circle", color: .green)
                    Button { store.showBlockedEvents() } label: {
                        MetricView(title: "Заблокировано", value: "\(store.status?.blocked ?? 0)", detail: "Нажмите, чтобы показать", icon: "hand.raised", color: .orange)
                    }.buttonStyle(.plain).help("Показать все блокировки, сбросив остальные фильтры")
                    MetricView(title: "Активно сейчас", value: "\(store.status?.connections ?? 0)", detail: "Соединений через Guard", icon: "arrow.left.arrow.right", color: .blue)
                    MetricView(title: "Передано", value: byteText((store.status?.bytesSent ?? 0) + (store.status?.bytesReceived ?? 0)), detail: "Внутри HTTPS-туннелей", icon: "chart.bar", color: .purple)
                }
                VStack(alignment: .leading, spacing: 10) {
                    HStack { Text("Журнал событий").font(.headline); Spacer(); Text("Только в памяти").font(.caption).foregroundStyle(.secondary) }
                    ActivityControls(store: store)
                    EventTable(store: store).frame(height: 260)
                    if let event = store.detail { EventDetail(event: event, store: store) }
                }
                Text("Статистика за текущий запуск. Guard управляет своим браузером; обычный Chrome блокирует чувствительные сайты через включённое расширение.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(22)
        }
    }
}

struct AccessView: View {
    @ObservedObject var store: GuardStore
    private var active: Bool { store.online && store.status?.state == .active }
    private var qualifying: Bool { store.online && store.status?.state == .qualifying }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 18) {
                    Image(systemName: active ? "checkmark.shield.fill" : "lock.shield")
                        .font(.system(size: 40)).foregroundStyle(active ? Color.green : Color.secondary)
                        .frame(width: 60)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(!store.online ? "Шлюз недоступен" : active ? "Доступ открыт для Guard" : qualifying ? "Проверяем маршрут" : "Доступ Guard закрыт")
                            .font(.title2.weight(.semibold))
                        Text(store.online ? (store.status?.message ?? "") : "Проверьте связь с локальным шлюзом.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    VStack(spacing: 8) {
                        Button { Task { await store.perform(.activate(store.selectedRoute)) } } label: {
                            Label(qualifying ? "Проверяем…" : active ? "Доступ открыт" : "Открыть доступ", systemImage: "checkmark.shield")
                        }
                        .buttonStyle(.borderedProminent).tint(.green)
                        .disabled(!store.canActivate)
                        Button { Task { await store.perform(.lock) } } label: {
                            Label("Закрыть доступ", systemImage: "lock")
                        }
                        .disabled(!store.canLock)
                    }.controlSize(.large)
                }
                Divider()
                Text("Обычный Chrome остаётся заблокированным. Для доступа введите адрес ниже или выберите заблокированный сайт в журнале и откройте его в Guard.")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Picker("Маршрут", selection: $store.selectedRoute) {
                        if (store.status?.routes ?? []).isEmpty { Text(store.online ? "Добавьте профиль" : "Шлюз недоступен").tag("") }
                        ForEach(store.status?.routes ?? []) { route in
                            Text(route.title + ((store.status?.routes.count ?? 0) > 1 ? " · \(route.id)" : "")).tag(route.id)
                        }
                    }
                    .frame(maxWidth: 400)
                    .disabled(!store.online || store.busy || store.status?.state != .locked)
                    Spacer()
                    if qualifying { ProgressView().controlSize(.small) }
                    Text(active ? "Проверено \(store.status?.verifiedAge ?? 0) с назад" : qualifying ? "Проверка выхода…" : "Ожидает проверки")
                        .font(.caption).foregroundStyle(.secondary).monospacedDigit()
                }
            }.padding(12)
        }
    }
}

struct MetricView: View {
    let title, value, detail, icon: String
    let color: Color
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 7) {
                Label(title, systemImage: icon).font(.caption).foregroundStyle(color)
                Text(value).font(.title2.weight(.medium)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
                Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(6)
        }
    }
}
