import SwiftUI
import GuardCore

struct OverviewView: View {
    @ObservedObject var store: GuardStore
    @State private var protectedBrowser = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ChromeAccessView(store: store)
                HStack {
                    Label("Блокировок за запуск: \(store.status?.chromeBlocked ?? 0)", systemImage: "hand.raised").font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button("Настройки и диагностика Chrome") { store.destination = .chrome }
                }
                DisclosureGroup("Дополнительно: отдельный защищённый браузер", isExpanded: $protectedBrowser) {
                    VStack(alignment: .leading, spacing: 16) {
                Text("Опциональный браузер со своим проверенным маршрутом. Его шлюз управляется отдельно от блокировки обычного Chrome.").font(.caption).foregroundStyle(.secondary)
                AccessView(store: store)
                BrowserLaunchView(store: store)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 12)], spacing: 12) {
                    MetricView(title: "Разрешено", value: "\(store.status?.allowed ?? 0)", detail: "Через шлюз Guard", icon: "checkmark.circle", color: .green)
                    Button { store.showBlockedEvents() } label: {
                        MetricView(title: "Заблокировано", value: "\(store.status?.blocked ?? 0)", detail: "Показать блокировки →", icon: "hand.raised", color: .orange)
                    }.buttonStyle(.plain).help("Открыть журнал блокировок всех источников")
                    MetricView(title: "Активно", value: "\(store.status?.connections ?? 0)", detail: "Открытых туннелей", icon: "arrow.left.arrow.right", color: .blue)
                    MetricView(title: "Передано", value: byteText((store.status?.bytesSent ?? 0) + (store.status?.bytesReceived ?? 0)), detail: "Внутри HTTPS-туннелей", icon: "chart.bar", color: .purple)
                }
                    }.padding(.top, 12)
                }
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Label("Последние события", systemImage: "clock").font(.headline)
                        Spacer()
                        Button("Весь журнал") { store.resetFilters(); store.destination = .activity }
                    }
                    EventTable(store: store).frame(height: 180).clipShape(RoundedRectangle(cornerRadius: 8))
                    if store.hasFilters {
                        HStack {
                            Text("В журнале включены фильтры").font(.caption).foregroundStyle(.secondary)
                            Button("Показать все") { store.resetFilters() }.controlSize(.small)
                        }
                    }
                }
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "info.circle").foregroundStyle(.secondary)
                    Text("Открытие и закрытие доступа на главной панели управляет блокировкой обычного Chrome. Журнал хранится только в памяти.")
                        .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 0)
                    Button("Как это работает") { store.showHelp() }.controlSize(.small)
                }
            }.padding(22).frame(maxWidth: 1100, alignment: .leading).frame(maxWidth: .infinity)
        }
    }
}

struct BrowserLaunchView: View {
    @ObservedObject var store: GuardStore
    private var empty: Bool { store.site.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private func open() { if store.canBrowse && !empty { Task { await store.perform(.open(store.site)) } } }
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label("Открыть защищённый сайт", systemImage: "globe").font(.headline)
                    Spacer()
                    Text("Отдельный профиль Chrome").font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 10) {
                    TextField("example.org или HTTPS-адрес", text: $store.site).textFieldStyle(.roundedBorder).onSubmit(open)
                    Button(action: open) { Label("Открыть в Guard", systemImage: "arrow.up.forward.app") }
                        .disabled(!store.canBrowse || empty)
                        .help("Открывает отдельный Chrome «GhostRoute Guard», а не обычный профиль")
                }.controlSize(.large)
                Text(store.canBrowse ? "Адрес откроется через проверенный маршрут. Обычный Chrome сохраняет свои блокировки." : "Сначала выберите маршрут и откройте доступ. Прямого обхода при ошибке нет.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(10)
        }
    }
}

struct AccessView: View {
    @ObservedObject var store: GuardStore
    private var active: Bool { store.online && store.status?.state == .active }
    private var qualifying: Bool { store.online && store.status?.state == .qualifying }
    private var accent: Color { active ? .green : qualifying ? .orange : .secondary }
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 14) {
                    Image(systemName: active ? "checkmark.shield.fill" : "lock.shield")
                        .font(.system(size: 32, weight: .medium)).foregroundStyle(accent)
                        .frame(width: 48, height: 48).background(accent.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 5) {
                        Text(!store.online ? "Шлюз недоступен" : active ? "Маршрут дополнительного браузера проверен" : qualifying ? "Проверяем маршрут" : "Шлюз дополнительного браузера закрыт")
                            .font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        Text(store.online ? (store.status?.message ?? "") : "Проверьте сообщение об ошибке и повторите запуск.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    if qualifying { ProgressView().controlSize(.small).padding(.top, 10) }
                }
                Divider()
                HStack(alignment: .bottom, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("МАРШРУТ").font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                        Picker("Маршрут", selection: $store.selectedRoute) {
                            if (store.status?.routes ?? []).isEmpty { Text(store.online ? "Добавьте профиль" : "Шлюз недоступен").tag("") }
                            ForEach(store.status?.routes ?? []) { route in
                                Text(route.title + ((store.status?.routes.count ?? 0) > 1 ? " · \(route.id)" : "")).tag(route.id)
                            }
                        }.labelsHidden().frame(maxWidth: 320).disabled(!store.online || store.busy || store.status?.state != .locked)
                    }
                    Spacer(minLength: 0)
                    if !active {
                        Button { Task { await store.perform(.activate(store.selectedRoute)) } } label: {
                            Label(qualifying ? "Проверяем…" : "Проверить маршрут", systemImage: "checkmark.shield")
                        }.buttonStyle(.borderedProminent).disabled(!store.canActivate)
                    }
                    Button { Task { await store.perform(.lock) } } label: { Label("Закрыть шлюз", systemImage: "lock") }.disabled(!store.canLock)
                }.controlSize(.large)
                if active {
                    Label("Выход проверен \(store.status?.verifiedAge ?? 0) с назад · проверка повторяется автоматически", systemImage: "checkmark.circle")
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
        VStack(alignment: .leading, spacing: 9) {
            Label(title, systemImage: icon).font(.caption.weight(.medium)).foregroundStyle(color)
            Text(value).font(.system(size: 26, weight: .semibold, design: .rounded)).monospacedDigit().lineLimit(1).minimumScaleFactor(0.7)
            Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
        }.frame(maxWidth: .infinity, minHeight: 90, alignment: .leading).padding(14)
            .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.04)))
    }
}
