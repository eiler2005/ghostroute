import SwiftUI
import GuardCore

struct ChromeView: View {
    @ObservedObject var store: GuardStore
    @State private var selected: String?
    private var agent: ChromeAgent? { store.chrome.agents.first { $0.id == store.selectedChrome } }
    private var entries: [ChromeHTTPEvent] { store.chrome.events.filter { $0.profile == store.selectedChrome } }
    private func send(_ command: ChromeCommand, event: String? = nil) {
        Task { await store.perform(.chromeCommand(store.selectedChrome, command, event)) }
    }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Google Chrome").font(.title2.weight(.semibold))
                        Text("Локальный агент: защита, события и диагностика одной вкладки").font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Справка") { store.showHelp() }
                }
                ChromeAccessView(store: store)
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Toggle("Передавать разрешения и блокировки", isOn: Binding(get: { agent?.reporting ?? true }, set: { send($0 ? .reportingOn : .reportingOff) }))
                                .toggleStyle(.switch).controlSize(.small)
                        }.disabled(agent == nil || agent?.pending == true || store.busy || !store.online)
                    }.padding(10)
                }
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Label("HTTP-диагностика", systemImage: "stethoscope").font(.headline)
                            Spacer()
                            Text(agent?.remaining ?? 0 > 0 ? "Запись · \(agent?.remaining ?? 0) с" : "Остановлено").font(.caption).foregroundStyle(.secondary)
                        }
                        Text("В нужной вкладке Chrome откройте ⌘⌥I → Guard и включите «Разрешить управление». Затем запускайте и останавливайте диагностику здесь. Скрытие панели отзывает разрешение.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Button("Начать на 60 секунд") { send(.start) }.disabled(agent?.ready != true || (agent?.remaining ?? 0) > 0)
                            Button("Остановить и стереть") { send(.stop) }.disabled(agent?.ready != true || (agent?.remaining ?? 0) == 0)
                            Button("Очистить") { send(.clear) }.disabled(agent?.ready != true)
                        }.disabled(store.busy || agent?.pending == true || !store.online)
                        Text(store.chrome.notice).font(.caption).foregroundStyle(.secondary)
                    }.padding(10)
                }
                Table(entries, selection: $selected) {
                    TableColumn("Домен") { Text($0.host).lineLimit(1) }.width(min: 150, ideal: 250)
                    TableColumn("Метод") { Text($0.method).font(.caption) }.width(65)
                    TableColumn("HTTP") { Text($0.status == 0 ? "Ошибка" : "\($0.status)").font(.caption).monospacedDigit() }.width(65)
                    TableColumn("Время") { Text("\($0.durationMs) мс").font(.caption).monospacedDigit() }.width(80)
                    TableColumn("Тип") { Text($0.mime).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                }.frame(height: 210).clipShape(RoundedRectangle(cornerRadius: 8))
                HStack {
                    Text("\(entries.count) ответов · до 100 в памяти").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Показать текст выбранного ответа") {
                        if let event = entries.first(where: { $0.id == selected }) { send(.preview, event: event.event) }
                    }.disabled(selected == nil || !entries.contains(where: { $0.id == selected }) || (agent?.remaining ?? 0) == 0 || agent?.pending == true)
                }
                if let preview = store.chrome.preview, preview.profile == store.selectedChrome {
                    GroupBox {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Label("Временный текст ответа", systemImage: "doc.text").font(.headline)
                                Spacer()
                                Button("Скрыть текст") { Task { await store.perform(.chromePreviewClear) } }
                            }
                            Text("Может содержать личные данные. До 1024 символов; срок предпросмотра — 15 секунд, затем текст скрывается при обновлении экрана. Это отдельный просмотр, не запись в журнал.").font(.caption).foregroundStyle(.secondary)
                            ScrollView { Text(preview.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 180)
                        }.padding(10)
                    }
                }
                Text("Диагностика не открывает доступ и не меняет proxy, DNS, VPN или роутер. При остановке и истечении времени её ответы удаляются. Решения правил остаются в общем журнале.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(22).frame(maxWidth: 1100, alignment: .leading).frame(maxWidth: .infinity)
        }
    }
}

struct ChromeAccessView: View {
    @ObservedObject var store: GuardStore
    private var agent: ChromeAgent? { store.online ? store.chrome.agents.first { $0.id == store.selectedChrome } : nil }
    private var allowed: Bool { agent?.protection == false }
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 14) {
                    Image(systemName: allowed ? "globe" : "hand.raised.fill")
                        .font(.system(size: 30)).foregroundStyle(allowed ? Color.green : .orange)
                        .frame(width: 48, height: 48).background((allowed ? Color.green : .orange).opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 5) {
                        Text(agent == nil ? "Нет связи с расширением Chrome" : allowed ? "Доступ в Chrome открыт" : "Сайты в Chrome заблокированы")
                            .font(.title2.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                        Text("Обычный Chrome · чувствительный каталог").font(.callout).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    if agent?.pending == true || agent?.accessChanging == true { ProgressView().controlSize(.small) }
                }
                if store.chrome.agents.count > 1 {
                    Picker("Сеанс Chrome", selection: $store.selectedChrome) {
                        ForEach(store.chrome.agents) { item in Text("Chrome · \(item.id.prefix(6))").tag(item.id) }
                    }.frame(maxWidth: 400)
                }
                HStack(spacing: 12) {
                    Button { Task { await store.setChromeAccess(true) } } label: {
                        Label("Открыть доступ в Chrome", systemImage: "lock.open")
                    }.buttonStyle(.borderedProminent)
                        .disabled(agent == nil || store.busy || (allowed && agent?.desiredAllowed == true))
                    Button { Task { await store.setChromeAccess(false) } } label: {
                        Label("Закрыть доступ в Chrome", systemImage: "lock")
                    }.disabled(!store.canBlockChrome)
                    Spacer(minLength: 0)
                }.controlSize(.large)
                Text(agent == nil ? "Запустите Chrome с включённым расширением Guard. Папку расширения можно открыть в настройках приложения." : agent?.pending == true || agent?.accessChanging == true ? "Chrome применяет настройку…" : allowed ? "Блокировка снята, пока приложение на связи. Сайты работают в этом же профиле Chrome; уже заблокированную страницу нужно обновить." : "Нажмите «Открыть доступ в Chrome», чтобы снять блокировку. Отдельный браузер запускать не нужно.")
                    .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Text("Используется текущая сеть и proxy обычного Chrome. Эта кнопка не проверяет и не меняет его IP-адрес или страну выхода.")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }.padding(12)
        }
    }
}
