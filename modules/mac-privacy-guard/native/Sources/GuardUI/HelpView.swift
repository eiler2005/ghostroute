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
                        Text("Доступ в обычном Chrome — под вашим управлением.").font(.title3).foregroundStyle(.secondary)
                        Text("Версия \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—") · локальное приложение для Mac").font(.caption).foregroundStyle(.secondary)
                    }
                }
                GroupBox {
                    VStack(alignment: .leading, spacing: 16) {
                        Label("Начало работы", systemImage: "play.circle").font(.headline)
                        step("1", "Откройте доступ в Chrome", "Запустите обычный Chrome с расширением Guard. На главной панели нажмите «Открыть доступ в Chrome» и дождитесь подтверждения.")
                        step("2", "Продолжайте в той же вкладке", "Используется ваш обычный профиль Chrome. Если страница уже показала ERR_BLOCKED_BY_CLIENT, обновите её.")
                        step("3", "Закройте доступ при необходимости", "«Закрыть доступ в Chrome» возвращает блокировку чувствительного каталога. Доступ также закрывается при потере связи с приложением.")
                        Button("Перейти к доступу") { store.destination = .overview }
                    }.padding(10)
                }
                topic("Защищённый браузер — дополнительная опция", icon: "rectangle.on.rectangle") {
                    Text("На главной панели в сворачиваемом разделе можно отдельно проверить маршрут и открыть дополнительный Chrome через обязательный шлюз. Его проверка и кнопка «Закрыть шлюз» не меняют блокировку обычного Chrome.")
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
                    Text("ERR_BLOCKED_BY_CLIENT в обычном Chrome: нажмите «Открыть доступ в Chrome» и обновите страницу. Если ошибка остаётся, проверьте выбранный сеанс расширения и другие блокировщики. Пустой журнал при растущих счётчиках: сбросьте фильтры.")
                    Text("Сломан отдельный ресурс: проверьте домен в журнале и его серверную политику перед изменением каталога. После смены сети, сна или VPN закройте доступ и повторите проверку.")
                }
                topic("Приватность и границы", icon: "hand.raised") {
                    Text("Журнал приложения — до 300 событий в памяти, без полных URL, паролей, cookies и содержимого страниц. HTTP-метаданные и явно запрошенный текст ответа хранятся отдельно и временно. Сам Chrome сохраняет историю и сессии своего профиля; это не Incognito.")
                    Text("Guard не скрывает аккаунт и fingerprint, не защищает от вредоносного процесса на Mac и не управляет всеми приложениями. Значок стороннего VPN не подтверждает его выход. Системный фильтр Network Extension сейчас не установлен.")
                }
                topic("Управление обычным Chrome", icon: "globe") {
                    Text("Главные кнопки разрешают или блокируют чувствительные сайты в обычном Chrome. Разрешение действует, пока приложение на связи, без минутного ограничения. Используются текущая сеть, аккаунты и proxy Chrome; IP и страна выхода этой кнопкой не проверяются.")
                    Text("При закрытии приложения, потере связи и новом запуске блокировка возвращается. Уже открытые WebSocket/streaming-потоки могут продолжаться до закрытия вкладки. Выключенное через настройки Chrome расширение не сможет принять команду приложения.")
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
