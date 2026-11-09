import SwiftUI
import GuardCore

public enum GuardPage: String, CaseIterable, Identifiable {
    case overview, activity, chrome, settings, help
    public var id: Self { self }
    var title: String {
        switch self { case .overview: return "Обзор"; case .activity: return "Журнал событий"; case .chrome: return "Google Chrome"; case .settings: return "Настройки"; case .help: return "Справка" }
    }
    var icon: String {
        switch self { case .overview: return "shield.lefthalf.filled"; case .activity: return "list.bullet.rectangle"; case .chrome: return "globe"; case .settings: return "gearshape"; case .help: return "questionmark.circle" }
    }
}

public struct GuardRootView: View {
    @ObservedObject var store: GuardStore

    public init(store: GuardStore) { self.store = store }

    public var body: some View {
        NavigationSplitView {
            List(GuardPage.allCases, selection: $store.destination) { item in
                Label(item.title, systemImage: item.icon).tag(item)
                    .padding(.vertical, 4)
            }
            .navigationTitle("GhostRoute Guard")
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 8) {
                    Image(nsImage: NSApplication.shared.applicationIconImage).resizable().frame(width: 28, height: 28)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("GhostRoute Guard").font(.caption.weight(.medium))
                        Text("Локально на вашем Mac").font(.caption2).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
            }
            .navigationSplitViewColumnWidth(min: 165, ideal: 185, max: 230)
        } detail: {
            VStack(spacing: 0) {
                if store.starting {
                    Spacer()
                    ProgressView("Запускаем локальный шлюз…").padding()
                    Spacer()
                } else {
                    switch store.destination ?? .overview {
                    case .overview: OverviewView(store: store)
                    case .activity: ActivityView(store: store)
                    case .chrome: ChromeView(store: store)
                    case .settings: SettingsView(store: store)
                    case .help: HelpView(store: store)
                    }
                }
                if let error = store.error {
                    HStack {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .font(.callout).foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !store.online && !store.starting && store.retryHandler != nil {
                            Button("Повторить запуск") { store.retryStartup() }
                                .help("Перезапускает собственный шлюз с закрытым доступом; профиль сохраняется")
                        }
                    }.padding(12).background(.regularMaterial)
                } else if let notice = store.notice {
                    Text(notice).font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                }
            }
            .navigationTitle((store.destination ?? .overview).title)
            .toolbar {
                ToolbarItem(placement: .automatic) {
                    HStack(spacing: 6) {
                        Circle().fill(store.online ? Color.green : Color.orange).frame(width: 6, height: 6)
                        Text(store.online ? "Шлюз на связи" : "Нет связи")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .help("Состояние локального шлюза, а не всей сети Mac")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { store.showHelp() } label: { Label("Справка", systemImage: "questionmark.circle") }
                        .help("Начало работы, диагностика и границы защиты")
                }
                ToolbarItem(placement: .primaryAction) {
                    Button { Task { await store.perform(.lock) } } label: {
                        Label("Закрыть доступ", systemImage: "lock.fill")
                    }
                    .disabled(!store.canLock)
                    .keyboardShortcut("l", modifiers: [.command, .shift])
                }
            }
        }
    }
}

struct DecisionLabel: View {
    let kind: EventKind
    var body: some View {
        Label(title, systemImage: icon).foregroundStyle(color).font(.caption)
    }
    var title: String {
        switch kind { case .allowed: return "Разрешено"; case .blocked: return "Заблокировано"; case .error: return "Ошибка сети"; case .system: return "Система" }
    }
    var icon: String {
        switch kind { case .allowed: return "checkmark.circle"; case .blocked: return "hand.raised"; case .error: return "exclamationmark.triangle"; case .system: return "gearshape" }
    }
    var color: Color {
        switch kind { case .allowed: return .green; case .blocked: return .orange; case .error: return .red; case .system: return .secondary }
    }
}

func byteText(_ value: Int64) -> String {
    value == 0 ? "0 Б" : ByteCountFormatter.string(fromByteCount: value, countStyle: .binary)
}
