import SwiftUI
import GuardCore

enum Section: String, CaseIterable, Identifiable {
    case overview, activity, settings
    var id: Self { self }
    var title: String {
        switch self { case .overview: return "Обзор"; case .activity: return "Журнал событий"; case .settings: return "Настройки" }
    }
    var icon: String {
        switch self { case .overview: return "shield.lefthalf.filled"; case .activity: return "list.bullet.rectangle"; case .settings: return "gearshape" }
    }
}

public struct GuardRootView: View {
    @ObservedObject var store: GuardStore
    @State private var section: Section? = .overview

    public init(store: GuardStore) { self.store = store }

    public var body: some View {
        NavigationSplitView {
            List(Section.allCases, selection: $section) { item in
                Label(item.title, systemImage: item.icon).tag(item)
                    .padding(.vertical, 4)
            }
            .navigationTitle("GhostRoute Guard")
            .safeAreaInset(edge: .bottom) {
                Label("Локально на вашем Mac", systemImage: "desktopcomputer")
                    .font(.caption).foregroundStyle(.secondary).padding()
            }
            .navigationSplitViewColumnWidth(min: 165, ideal: 185, max: 230)
        } detail: {
            VStack(spacing: 0) {
                if store.starting {
                    Spacer()
                    ProgressView("Запускаем локальный шлюз…").padding()
                    Spacer()
                } else {
                    switch section ?? .overview {
                    case .overview: OverviewView(store: store)
                    case .activity: ActivityView(store: store)
                    case .settings: SettingsView(store: store)
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
            .navigationTitle((section ?? .overview).title)
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
