import SwiftUI
import GuardCore

struct ChromeView: View {
    @ObservedObject var store: GuardStore
    @State private var pauseConfirmation = false
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
                Picker("Сеанс расширения", selection: $store.selectedChrome) {
                    if store.chrome.agents.isEmpty { Text("Нет подключённого агента").tag("") }
                    ForEach(store.chrome.agents) { item in Text("Chrome · \(item.id.prefix(6))").tag(item.id) }
                }.frame(maxWidth: 420)
                GroupBox {
                    VStack(alignment: .leading, spacing: 12) {
                        Label(agent == nil ? "Нет свежего сигнала расширения" : agent?.protection == true ? "Блокировка Chrome включена" : "Блокировка Chrome приостановлена", systemImage: agent?.protection == true ? "checkmark.shield.fill" : "exclamationmark.shield")
                            .font(.headline).foregroundStyle(agent == nil ? Color.secondary : agent?.protection == true ? .green : .orange)
                        Text("Это обычный Chrome. Пауза разрешает ему использовать обычную сеть Mac; зелёный статус Guard не меняет его маршрут.")
                            .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        HStack {
                            if agent?.protection == false {
                                Button("Возобновить блокировку") { send(.resumeProtection) }
                                    .buttonStyle(.borderedProminent)
                                Text("Пауза: до \(agent?.pauseRemaining ?? 0) с").font(.caption).foregroundStyle(.secondary)
                            } else {
                                Button("Пауза блокировки на 60 секунд…") { pauseConfirmation = true }
                            }
                            Spacer()
                            Toggle("Передавать события блокировок", isOn: Binding(get: { agent?.reporting ?? true }, set: { send($0 ? .reportingOn : .reportingOff) }))
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
                Text("Диагностика не открывает доступ и не меняет proxy, DNS, VPN или роутер. При остановке и истечении времени её ответы удаляются. Блокировки остаются в общем журнале.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding(22).frame(maxWidth: 1100, alignment: .leading).frame(maxWidth: .infinity)
        }
        .confirmationDialog("Приостановить блокировку Chrome?", isPresented: $pauseConfirmation, titleVisibility: .visible) {
            Button("Приостановить на 60 секунд", role: .destructive) { send(.pauseProtection) }
            Button("Отмена", role: .cancel) {}
        } message: { Text("Чувствительные сайты смогут открываться обычным путём Mac. Guard не направит этот Chrome через свой шлюз. Блокировка вернётся по таймеру или при потере связи с приложением.") }
    }
}
