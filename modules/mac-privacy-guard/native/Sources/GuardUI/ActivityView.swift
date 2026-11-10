import AppKit
import SwiftUI
import GuardCore

struct ActivityView: View {
    @ObservedObject var store: GuardStore
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Журнал событий").font(.title2.weight(.semibold))
                    Text("Последние 300 событий · только в памяти").font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Text("Сетевых ошибок: \(store.status?.errors ?? 0)").font(.caption).foregroundStyle(.secondary)
            }
            ActivityControls(store: store)
            EventTable(store: store)
            if let event = store.detail { EventDetail(event: event, store: store) }
        }.padding(22)
    }
}

struct ActivityControls: View {
    @ObservedObject var store: GuardStore
    var body: some View {
        VStack(spacing: 10) {
            Picker("Решение", selection: $store.filter) {
                Text("Все").tag(EventKind?.none)
                ForEach(EventKind.allCases, id: \.self) { kind in
                    Text(DecisionLabel(kind: kind).title).tag(Optional(kind))
                }
            }.pickerStyle(.segmented).labelsHidden()
            HStack {
                Picker("Источник", selection: $store.source) {
                    Text("Все источники").tag("all")
                    Text("Шлюз Guard").tag("guard")
                    Text("Обычный Chrome").tag("chrome")
                    Text("Приложение").tag("app")
                }.frame(width: 240)
                TextField("Поиск домена или причины", text: $store.search)
                    .textFieldStyle(.roundedBorder)
                Button("Очистить журнал") { Task { await store.perform(.clearActivity) } }
                    .disabled(!store.online || store.busy || store.events.isEmpty)
                    .help("События удаляются; счётчики текущего запуска сохраняются")
            }
            HStack {
                Text("Показано \(store.visibleEvents.count) из \(store.events.count) событий")
                    .font(.caption).foregroundStyle(.secondary)
                Spacer()
                if store.hasFilters {
                    Button("Показать все события") { store.resetFilters() }.controlSize(.small)
                }
            }
        }
    }
}

struct EventTable: View {
    @ObservedObject var store: GuardStore
    var body: some View {
        Table(store.visibleEvents, selection: $store.selectedEvent) {
            TableColumn("Время") { event in
                Text(event.date, format: .dateTime.hour().minute().second()).font(.caption).monospacedDigit().foregroundStyle(.secondary)
            }.width(72)
            TableColumn("Назначение / событие") { event in
                VStack(alignment: .leading, spacing: 3) {
                    Text(event.host ?? event.message).lineLimit(1)
                    Text(event.isChrome ? "Обычный Chrome · \(event.method ?? "") · \(resourceTitle(event.resourceType))" : event.host == nil ? "Guard · управление доступом" : event.message)
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                .help(event.message)
                .contextMenu {
                    if let host = event.host {
                        Button("Скопировать домен") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(host, forType: .string) }
                    }
                }
            }.width(min: 180, ideal: 350)
            TableColumn("Решение") { event in DecisionLabel(kind: event.kind) }.width(125)
            TableColumn("Передача") { event in
                VStack(alignment: .leading, spacing: 3) {
                    Text(event.kind == .allowed && !event.isChrome ? byteText(event.bytesSent + event.bytesReceived) : "—").monospacedDigit()
                    if let state = event.state { Text(state == "open" ? "Открыто" : "Завершено").font(.caption2).foregroundStyle(.secondary) }
                }.font(.caption)
            }.width(90)
        }
        .overlay {
            if store.visibleEvents.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "list.bullet.rectangle").font(.title).foregroundStyle(.tertiary)
                    Text(store.events.isEmpty ? "Здесь появятся новые события" : "Подходящих событий нет").font(.callout).foregroundStyle(.secondary)
                    if store.events.isEmpty {
                        Text("Откройте сайт из чувствительного каталога в Chrome с включённой передачей событий.").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("Фильтры скрывают \(store.hiddenEventCount) событий, включая блокировки и ошибки.")
                            .font(.caption).foregroundStyle(.secondary)
                        Button("Показать все события") { store.resetFilters() }
                    }
                }.padding()
            }
        }
    }
}

struct EventDetail: View {
    let event: GuardEvent
    @ObservedObject var store: GuardStore
    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                HStack { Text(event.host ?? "Событие приложения").font(.headline).textSelection(.enabled); Spacer(); DecisionLabel(kind: event.kind) }
                Text(event.message).font(.callout).foregroundStyle(.secondary)
                HStack(alignment: .top, spacing: 28) {
                    DetailValue(title: "Источник", value: event.isChrome ? "Правила Chrome" : event.source == "app" ? "Приложение" : "Шлюз Guard")
                    if event.isChrome {
                        DetailValue(title: "Метод / тип", value: "\(event.method ?? "—") · \(resourceTitle(event.resourceType))")
                        DetailValue(title: "Правило", value: "\(event.ruleId ?? 0)")
                    } else if event.kind == .allowed {
                        DetailValue(title: "Отправлено / получено", value: "\(byteText(event.bytesSent)) / \(byteText(event.bytesReceived))")
                        DetailValue(title: "Состояние", value: closureTitle(event))
                        DetailValue(title: "Длительность", value: event.durationMs.map { String(format: "%.1f с", Double($0)/1000) } ?? "Продолжается")
                    }
                    Spacer()
                }
                if event.isChrome, let host = event.host {
                    HStack {
                        Button("Открыть в защищённом Chrome") { Task { await store.openBlockedSite(host) } }
                            .disabled(!store.canBrowse)
                        if !store.canBrowse { Text("Сначала откройте доступ для Guard в разделе «Обзор».").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }.padding(8)
        }
    }
}

struct DetailValue: View {
    let title, value: String
    var body: some View { VStack(alignment: .leading, spacing: 3) { Text(title).font(.caption2).foregroundStyle(.secondary); Text(value).font(.caption).textSelection(.enabled) } }
}

func resourceTitle(_ value: String?) -> String {
    ["main_frame":"страница", "sub_frame":"встроенная страница", "script":"скрипт", "image":"изображение", "stylesheet":"стили", "xmlhttprequest":"запрос приложения", "font":"шрифт", "media":"медиа"][value ?? ""] ?? "другой ресурс"
}

func closureTitle(_ event: GuardEvent) -> String {
    if event.state == "open" { return "Открыто" }
    return ["manual_lock":"Закрыто пользователем", "route_changed":"Смена маршрута", "check_failed":"Ошибка проверки", "expired":"Проверка устарела", "profile_updated":"Профиль обновлён", "interrupted":"Сетевая ошибка"][event.closeReason ?? ""] ?? "Завершено"
}
