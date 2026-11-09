# Эксплуатация GhostRoute Guard

## Локальные компоненты

| Компонент | Где находится | Назначение |
|---|---|---|
| Исходники | `modules/mac-privacy-guard/` | Python gate/controller, Swift shell, UI, installer, тесты |
| Приложение | `~/Applications/GhostRoute Guard.app` | Собранный ad-hoc signed bundle; не App Store/notarized distribution |
| Состояние | `~/Library/Application Support/GhostRoute Guard/` | Приватный каталог 700 |
| Профиль | `profile.json` внутри состояния | Маршруты, доверенные сертификаты/выходы, credentials; 600 |
| `Browser/` | Внутри состояния | Отдельные Chrome cookies, история и настройки |
| `gate-port`, `browser-pid`, `app.lock` | Внутри состояния | Локальное владение listener/browser; не deployment inventory |
| `Chrome Blocker/` | Внутри состояния | Unpacked MV3 extension; включается отдельно в Chrome |
| Тестовые отчёты | Игнорируемый `reports/mac-guard-design/` | Локальные доказательства, скриншоты и приватная подготовка |

Bundle содержит копию исходников, но использует зафиксированный путь к Python,
который его собирал. После удаления/замены этого interpreter пересобрать bundle.
Это не копия роутера/VPS и не отдельная инфраструктура egress.

## Приватный профиль

Формат ниже — **шаблон с placeholders**, не готовый профиль. Подставлять значения
только в приватном файле. Корневые поля и route fields проверяются строго;
неизвестные типы, fallback/direct fields и пустые allowlists для HTTPS запрещены.

```json
{
  "schema_version": 1,
  "sensitive_domains": ["sensitive.example.org"],
  "routes": [{
    "id": "home_sensitive",
    "kind": "https_proxy",
    "host": "<home_ingress_host>",
    "port": "<numeric_https_ingress_port>",
    "server_name": "<certificate_hostname>",
    "username": "<existing_selected_client>",
    "password": "<private_credential>",
    "certificate_sha256": "<independently_obtained_leaf_certificate_sha256>",
    "allowed_domains": ["sensitive.example.org"],
    "probe_url": "https://sensitive.example.org/cdn-cgi/trace",
    "probe_format": "cloudflare_trace",
    "approved_exit_ips": ["<approved_public_exit_ip>"]
  }]
}
```

1. Использовать уже существующий C **HTTPS CONNECT** URI и соответствующую
   выбранную identity. Не брать Naive URI/порт, не менять публичный ingress и
   не регенерировать другие клиентские импорты. Повторное использование identity
   объединяет её server-side accounting; отдельная новая identity — отдельный
   согласованный deploy.
2. Получить leaf certificate по уже доверенному SSH/control пути либо использовать
   публично доверенный сертификат с верным именем (тогда поле pin опустить).
   Нельзя получить «доверенный» pin с того же непроверенного первого соединения.
3. Проверить deployed sensitive rule, его inbound scope и отсутствие direct
   catch-all раньше него. Все `allowed_domains` должны быть покрыты этой policy.
   Базовый список — `configs/sensitive-domains.txt`; он содержит нужные auth-домены,
   но не все возможные ресурсы любой страницы.
4. Получить ожидаемый публичный egress IP из доверенного управления backend.
   Не копировать автоматически IP текущего Mac и не одобрять наблюдаемый выход
   только потому, что запрос успешен. Backend server IP и egress IP могут
   различаться: при NAT нужна независимая проверка ожидаемого выхода.
5. Выбрать HTTPS canary, который сам попадает в эту же policy. `plain_ip` ожидает
   только IP в body; `cloudflare_trace` — ровно одну строку `ip=...`. Ответы с
   redirect, ошибкой, несколькими IP или неверным IP не открывают доступ.
6. Сохранить JSON с правами 600 и импортировать через приложение. Импорт закрывает
   старые соединения и требует повторной проверки. В Git профиль не помещать.

Exact certificate pin осознанно заменяет CA/hostname trust: доверяется конкретный
leaf DER, включая self-signed. Автоматического TOFU или обновления pin нет.
После штатного renew доступ закроется; сверить новый сертификат доверенным путём,
обновить приватный профиль и повторить проверку. Не удалять pin ради обхода ошибки.

## Сторонний VPN

Второй route может иметь поля:

```json
{
  "id": "approved_vpn",
  "kind": "bound_vpn",
  "interface": "utun9",
  "allowed_domains": [],
  "probe_url": "https://api.ipify.org/",
  "probe_format": "plain_ip",
  "approved_exit_ips": ["<approved_public_exit_ip>"]
}
```

`utun9` — вымышленный пример. Выбирать фактически принадлежащий конкретному VPN
интерфейс, а не первый интерфейс с этим префиксом. Сначала включить и независимо
квалифицировать VPN по [матрице](security-and-testing.md). Guard не запускает VPN,
не меняет маршруты macOS и не разрешает доступ через обычную physical interface.
При смене имени/index или IP выхода требуется проверка/обновление профиля.

Пустой VPN allowlist разрешает публичные HTTPS назначения через выбранный
туннель. DNS A lookup выполняется через DoH с фиксированным публичным bootstrap
в том же `utun`; system DNS для целевых сайтов не используется. IPv6 literals
получают IPv6 socket с binding; доменные AAAA в этой версии не запрашиваются.
Это ограничение совместимости, а не direct IPv6 fallback.

## Отказы и восстановление

| Симптом | Безопасное действие |
|---|---|
| Проверка выхода не прошла | Проверить доступность и trust выбранного маршрута; не добавлять текущий IP вслепую |
| Не загружается ресурс страницы | Найти зависимость в DevTools локально; проверить её server-side policy перед добавлением в allowlist |
| Сертификат обновился | Сверить новый pin независимым доверенным способом |
| Старый защищённый Chrome остался после аварии | Закрыть именно его окно; обычный Chrome не завершать |
| Loopback gate port занят | Закрыть Guard и старый защищённый Chrome; определить владельца. Только после этого удалить `gate-port` и перезапустить |
| Изменился VPN/сеть или Mac проснулся | Закрыть доступ и повторить проверку. Не считать предыдущий зелёный статус приёмкой нового подключения |
| Обычный Chrome открывает sensitive-сайт | Проверить включение blocker в этом профиле и Incognito; приложение не устанавливает его молча |

Guard разрывает tracked tunnels по Lock, смене профиля/маршрута и неудачной
периодической проверке. Проверка выполняется каждые 15 секунд; новый CONNECT
не принимается при возрасте успешной проверки более 45 секунд. VPN дополнительно
проверяется перед каждым CONNECT, затем каждый сокет проверяет index и binding.
Это не мгновенный детектор любого изменения server-side policy или DNS.
Существующий HTTPS tunnel к home proxy остаётся TLS-соединением с тем же peer.

Повторный launch всегда locked. При обычном выходе native shell завершает backend;
backend также замечает исчезновение parent process и закрывается. При убийстве
самого gate оставшийся Chrome сохраняет fixed proxy и теряет доступ. Не запускать
сохранённый профиль вручную без обязательных flags.

## Обновление, копия и rollback

1. Закрыть Guard и его браузер. Сохранить приватный `profile.json` в уже принятом
   **зашифрованном** recovery bundle. Профиль содержит пароль proxy.
2. Записать commit исходников. Переименовать прежний `.app` в локальный rollback
   bundle и выполнить `bin/install-mac` заново. Installer не перезаписывает
   существующее приложение и не трогает приватный профиль.
3. При обновлении sensitive-каталога пересобрать extension через
   `bin/install-mac --extension-only`, затем нажать Reload в `chrome://extensions`.
   Guard allowlist обновляется отдельно после сверки deployed router policy.
4. Для rollback закрыть новый экземпляр, вернуть прежний bundle и соответствующий
   приватный профиль; проверить маршрут до открытия сайтов.

`Browser/` содержит сессии/историю и по умолчанию не должен попадать в обычный
диагностический архив. Для восстановления маршрутов достаточно исходников,
Python/Chrome и приватного профиля; browser sessions можно создать заново.
`gate-port`, lock и PID не переносить на другой Mac. Blocker пересобрать и включить
в новом профиле вручную. Зашифрованная копия на том же Mac не является offsite.
См. [общий backup contract](../../secrets-management/docs/vault-offsite-backup.md).

Удаление: закрыть Guard и защищённый Chrome, удалить `.app`, затем при необходимости
приватный каталог. Blocker удалить/выключить отдельно в Chrome. Это снимает
соответствующую клиентскую защиту; на роутере откатывать нечего.
