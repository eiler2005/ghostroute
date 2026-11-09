import SwiftUI
import GuardCore

struct HelpView: View {
    @ObservedObject var store: GuardStore
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                HStack(spacing: 16) {
                    Image(nsImage: NSApplication.shared.applicationIconImage).resizable().frame(width: 76, height: 76)
                    VStack(alignment: .leading, spacing: 5) {
                        Text("GhostRoute Guard").font(.largeTitle.weight(.semibold))
                        Text("Проверенный маршрут. Осознанный доступ.").font(.title3).foregroundStyle(.secondary)
                        Text("Версия \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—") · локальное приложение для Mac").font(.caption).foregroundStyle(.secondary)
                    }
                }
                GroupBox {
                    VStack(alignment: .leading, spacing: 16) {
                        Label("Начало работы", systemImage: "play.circle").font(.headline)
                        step("1", "Проверьте маршрут", "В «Обзоре» выберите домашний маршрут или заранее настроенный VPN и нажмите «Открыть доступ».")
                        step("2", "Откройте сайт в Guard", "Введите адрес и нажмите «Открыть в Guard». Появится отдельный Chrome без cookies вашего обычного профиля.")
                        step("3", "Проверьте результат", "Туннели и объём передачи видны в журнале. Запуск окна ещё не означает успешную загрузку страницы.")
                        Button("Перейти к доступу") { store.destination = .overview }
                    }.padding(10)
                }
                topic("Два браузера — две роли", icon: "rectangle.on.rectangle") {
                    Text("Guard разрешает своему Chrome только проверенный путь. В обычном Chrome расширение блокирует чувствительный каталог независимо от зелёного статуса приложения. Для доступа используйте отдельное окно Guard.")
                    Text("Расширение включается отдельно в каждом профиле Chrome. Один свежий сигнал не подтверждает защиту других профилей или Incognito.")
                }
                topic("Журнал и блокировки", icon: "list.bullet.rectangle") {
                    Text("Нажмите счётчик «Заблокировано», чтобы открыть отказы всех источников. «Показать все события» сбрасывает поиск и фильтры. Нажмите строку для причины и действия «Открыть в защищённом Chrome».")
                    Text("Передача — байты внутри туннелей Guard, включая TLS, а не трафик всего Mac. Очистка журнала не сбрасывает счётчики запуска.")
                }
                topic("HTTP-диагностика Chrome", icon: "stethoscope") {
                    Text("В обычном Chrome откройте инструменты разработчика (⌘⌥I), вкладку Guard и разрешите управление из приложения. В разделе Google Chrome этого приложения можно начать запись на 60 секунд, остановить её, очистить данные и запросить текст выбранного ответа.")
                    Text("Данные относятся только к подготовленной вкладке. Предпросмотр — до 1024 символов; он может содержать личные данные, не исполняет HTML и удаляется из приложения через 15 секунд. Заголовки, cookies и тела запросов не передаются. Остановка, скрытие панели и истечение сеанса стирают диагностику. Навигация очищает предыдущие ответы.")
                    Text("В защищённом Chrome расширения отключены: используйте его встроенную вкладку Network → Response. Не переносите туда обычный блокировщик — он будет блокировать те же сайты. Диагностика наблюдает ответы браузера, не устанавливает корневой сертификат и не меняет маршрут.")
                }
                topic("Если что-то не работает", icon: "wrench.and.screwdriver") {
                    Text("Нет маршрутов и «Шлюз недоступен»: прочитайте ошибку внизу окна, нажмите «Повторить запуск». Профиль сохраняется. При занятом порте закройте только прежний защищённый Chrome и Guard, затем запустите приложение снова.")
                    Text("ERR_BLOCKED_BY_CLIENT в обычном Chrome: откройте сайт кнопкой Guard. Пустой журнал при растущих счётчиках: сбросьте фильтры. Ошибка сертификата или выхода: доступ остаётся закрытым; не одобряйте случайный IP и не отключайте проверку сертификата.")
                    Text("Сломан отдельный ресурс: проверьте домен в журнале и его серверную политику перед изменением каталога. После смены сети, сна или VPN закройте доступ и повторите проверку.")
                }
                topic("Приватность и границы", icon: "hand.raised") {
                    Text("Журнал приложения — до 300 событий в памяти, без полных URL, паролей, cookies и содержимого страниц. HTTP-метаданные и явно запрошенный текст ответа хранятся отдельно и временно. Сам Chrome сохраняет историю и сессии своего профиля; это не Incognito.")
                    Text("Guard не скрывает аккаунт и fingerprint, не защищает от вредоносного процесса на Mac и не управляет всеми приложениями. Значок стороннего VPN не подтверждает его выход. Системный фильтр Network Extension сейчас не установлен.")
                }
                topic("Управление обычным Chrome", icon: "globe") {
                    Text("В разделе Google Chrome выберите сеанс расширения. Можно выключить передачу событий блокировок и независимо поставить саму блокировку на паузу на 60 секунд с подтверждением. Пауза допускает обычный сетевой путь Mac и не включает proxy Guard.")
                    Text("Блокировка возвращается по таймеру и при потере связи с приложением. Команды требуют подтверждения агента; отсутствие свежего сигнала не считается включённой защитой. Приостановка не отключает расширение целиком: выключенное вручную расширение не сможет принять команду возобновления.")
                }
            }.padding(24).frame(maxWidth: 840, alignment: .leading).frame(maxWidth: .infinity)
        }
    }
    private func step(_ number: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(number).font(.headline).foregroundStyle(Color.accentColor).frame(width: 28, height: 28).background(Color.accentColor.opacity(0.1), in: Circle())
            VStack(alignment: .leading, spacing: 4) { Text(title).font(.headline); Text(text).foregroundStyle(.secondary) }
        }.font(.callout)
    }
    private func topic<Content: View>(_ title: String, icon: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(title, systemImage: icon).font(.headline)
            content().font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
    }
}
