# Channel C Shadowrocket — Debug Research & Solution Paths (2026-04-27)

> Historical diagnostic note. Channel C is not production-ready and is not an
> active fallback channel. The research below records experiments and possible
> future paths; Channel A remains the production router-managed path.

## Context

Channel C — это будущий manual-only экспериментальный канал клиент-к-VPS. В этой
диагностической ветке он тестировался как HTTPS forward-proxy:
`iPhone (Shadowrocket) → TLS+CONNECT → public_host:443 → Caddy L4 (SNI route) → stunnel → Squid → upstream`.

**Текущее состояние:**

- Серверная часть проходит live-проверки: `curl --proxy https://USER:PASS@host:443 https://api.ipify.org` возвращает VPS IP, `generate_204` отвечает HTTP 204, `CONNECT` рукопожатие чистое.
- Все три VPS-сервиса активны: `caddy`, `channel-c-squid`, `channel-c-stunnel`.
- Channel A (Reality на той же `:443` через SNI `gateway.icloud.com`) не сломан — `verify.sh` зелёный.
- Каждому iPhone-клиенту сгенерированы 8 разных вариантов импорт-артефактов (URI/conf/QR keyword/positional/fields/etc.) в `ansible/out/clients-channel-c/`.

**Симптом:** на iPhone профиль `iphone-1-https-proxy` визуально выбран в Shadowrocket, Global Routing = Proxy, в Data-log видны `api.ipify.org:443`, `www.google.com:443`, `clients4.google.com:443`, `mask.icloud.com`, `gateway.icloud.com` — все с rule `ROUTING,PROXY # iphone-1-https-proxy`. Но интернет в браузере и приложениях не открывается.

**Цель документа:** разложить пространство возможных причин, дать proof-of-cause диагностику для каждой, выписать пути решения с приоритетами и архитектурными альтернативами на случай, если Channel C окажется системно хрупким.

---

## TL;DR

Три самые вероятные причины, в порядке убывания (с учётом того, что серверный curl работает):

1. **iOS iCloud Private Relay / Limit IP Address Tracking активен** — самый частый «тихий saboteur» при HTTPS-proxy профилях. Симптом «Data log показывает `mask.icloud.com` и `gateway.icloud.com`» — почти signature. **Проверка: 30 секунд в Settings.**
2. **Shadowrocket-positional конфиг неправильно парсит auth-поля** — Surge-стиль `https, host, port, USER, PASS` исторически работает только в keyword-форме `https, host, port, auth_user=USER, auth_pass=PASS`. Без auth Squid отвечает 407, tunnel не открывается, но Shadowrocket Data-log всё равно показывает routing. **Проверка: переимпорт keyword-варианта.**
3. **Профиль импортирован, но активный server в работающем VPN-инстансе — другой** — Shadowrocket гочи: импорт `.conf` через subscription создаёт новый Server List, но запущенный tunnel держит ссылку на старый Server. **Проверка: VPN OFF → подождать 5 сек → VPN ON.**

Если все три отбросили — переходим к остальным 10 гипотезам в §3.

**Кратчайший путь к ответу прямо сейчас:** запустить параллельно (a) Squid `tail -f` на VPS и (b) одну попытку открытия `http://neverssl.com` (HTTP, не HTTPS!) с iPhone. Результат однозначно укажет в одну из веток.

---

## 1. Architecture trace — где именно может сломаться

### 1.1 Серверная цепочка (что работает по curl)

```
Wire           Termination          Auth           Pass-through
────────────────────────────────────────────────────────────────
:443 (TCP)    Caddy L4 (SNI)        —              proxy → 18443
:18443        stunnel (TLS terminate, LE cert) —    plain HTTP → 18889
:18889        Squid (HTTP CONNECT, basic auth)  Authorization: Basic … → upstream
```

**Контракт SNI-routing:** Caddy `layer4` инспектирует TLS Client Hello, не терминируя. Если SNI == `channel_c_naive_public_host` → proxy на stunnel. Иначе fallthrough → Reality (`gateway.icloud.com`) → Xray. SNI mismatch ⇒ traffic уходит в Reality, который порвёт TLS handshake (т.к. Reality ждёт свою magic-handshake, а тут обычный TLS).

**Контракт TLS-cert:** stunnel читает живой LE-сертификат из `/var/lib/caddy/.local/share/caddy/certificates/.../<host>/<host>.crt`. Caddy renew → stunnel должен видеть новый cert (он читает файл при каждом TLS handshake, не кеширует — но это нужно перепроверить эмпирически).

**Контракт Squid auth:** `auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/channel-c.htpasswd` + `acl channel_c_auth proxy_auth REQUIRED` + `http_access allow channel_c_auth`. Без `Proxy-Authorization: Basic <b64(user:pass)>` Squid вернёт `407 Proxy Authentication Required`.

### 1.2 Клиентская цепочка (что должно делать Shadowrocket)

```
App socket
  └─> Shadowrocket NetworkExtension VPN tunnel (PacketTunnelProvider / Per-App)
       └─> Outer TLS to public_host:443  (cert validation against iOS trust store)
            └─> HTTP/1.1 CONNECT target.com:443 with Proxy-Authorization
                 └─> 200 Connection established
                      └─> Inner TLS to target.com (validation, ALPN, …)
                           └─> Plain HTTP/2 request → response
```

**5 логических слоёв** где может тихо сломаться:

| Слой | Что проверяет | Чем отличается от curl |
|---|---|---|
| iOS NetworkExtension | Per-app routing, IPv4/v6, MTU | curl на Mac не использует NE |
| iOS DNS | Может локально резолвить hostname в CONNECT | curl шлёт hostname как есть |
| iOS Trust Store | LE intermediate, OCSP stapling | curl/macOS делит trust store с iOS, но не с iCloud Private Relay |
| Shadowrocket parser | `.conf` файл → live profile | curl читает CLI args |
| TLS-in-TLS engine | Outer TLS 1.3 + inner TLS 1.3, 0-RTT, ALPN | curl с `--proxy https://...` делает то же самое; ключевое отличие — поверх iOS NE |

### 1.3 Что от curl до iPhone общего: **outer TLS + CONNECT + inner TLS — байт-в-байт идентично.**

Поэтому отличие должно быть либо в (a) auth-заголовке, либо в (b) SNI/cert на outer TLS, либо в (c) что-то iOS-специфичное (Private Relay/NE), либо в (d) Shadowrocket клиент сам не ходит, а только показывает что ходит.

---

## 2. Evidence collection — что у нас есть и чего не хватает

### 2.1 Confirmed (server-side)

- `curl --proxy https://USER:PASS@host:443 https://api.ipify.org` → возвращает VPS public IP ✅
- `curl --proxy https://USER:PASS@host:443 https://www.google.com/generate_204` → HTTP 204 ✅
- `CONNECT api.ipify.org:443` → `HTTP/1.1 200 Connection established` ✅
- Squid access log: `TCP_TUNNEL/200 CONNECT api.ipify.org:443` (при curl-попытке) ✅
- VPS listeners: `caddy :443`, `stunnel 127.0.0.1:18443`, `Squid 127.0.0.1:18889` ✅
- `99-verify.yml --limit vps_stealth` → green ✅
- Channel A не отвалился (`verify.sh` warning только о blocked-list freshness) ✅

### 2.2 Reported (client-side)

- Shadowrocket UI: `iphone-1-https-proxy` selected, Global Routing = Proxy.
- Data log entries: `api.ipify.org:443`, `www.google.com:443`, `clients4.google.com:443`, `mask.icloud.com`, `gateway.icloud.com` с rule `ROUTING,PROXY # iphone-1-https-proxy`.
- Browser/app: «no internet» / страницы не открываются.
- Использован профиль `iphone-1-shadowrocket-positional.conf` (positional форма).

### 2.3 Critical gap — что НЕ собрано

| Артефакт | Зачем нужен | Команда |
|---|---|---|
| Свежий Squid access log во время попытки c iPhone | Различить (a) iPhone не доходит до Squid, (b) доходит но 407, (c) tunnel ok но bytes=0 | `ssh deploy@vps 'sudo tail -f /var/log/squid/channel-c-access.log'` параллельно с попыткой |
| stunnel log во время попытки | Видеть, состоялся ли TLS handshake от iPhone (TLS error vs. clean) | `ssh deploy@vps 'sudo tail -f /var/log/stunnel4/channel-c.log'` |
| pcap WAN-side во время попытки | Если логи молчат — увидеть, дошли ли SYN от iPhone | `sudo timeout 60 tcpdump -ni any 'tcp port 443 or tcp port 18443 or tcp port 18889' -w /tmp/c.pcap` |
| Status iCloud Private Relay/IP Tracking | Однозначно отбросить или подтвердить H1 | iOS Settings, скриншот |
| Plain HTTP test | Различить (a) проблема только с TLS-in-TLS, (b) полный отказ proxy | `Safari: http://neverssl.com` |
| Built-in connectivity test Shadowrocket | Внутренний тест без смешения с приложениями | Shadowrocket → Server → tap server → Test |
| Mac через тот же профиль | Изолировать iOS-specific issue от proxy/profile issue | Mac SOCKS/HTTP proxy mode |

**Без свежих Squid логов вся остальная диагностика — догадки.** Это must-collect step #0.

---

## 3. Hypothesis matrix

13 гипотез, каждая с severity (вероятность × impact), signal-выявителем, fix path.

### H1 — iCloud Private Relay / Limit IP Address Tracking активен 🔴 ВЫСОКАЯ

**Severity:** очень высокая. Это самый частый источник «proxy-доступен-но-интернета-нет» на iOS 15+.

**Механика:**
- Apple iCloud+ Private Relay (для iCloud-подписчиков): включён по умолчанию, маскирует IP к Apple-relay'ям (`mask.icloud.com`, `mask-h2.icloud.com`).
- Limit IP Address Tracking (Settings → Wi-Fi/Cellular → Limit IP Address Tracking): per-network toggle, по умолчанию ON для известных трекеров.
- Эти механизмы **обходят VPN/proxy** для определённых endpoint'ов даже когда Shadowrocket активен.
- Когда Private Relay не может установить связь с `mask.icloud.com` (что в РФ на LTE — частый сценарий: Apple-relay-CDN дёргается с RU IP, бывают флапы) — iOS зависает на `Trying to connect to Apple's relay…`, и в это время **другие соединения тоже могут стопориться** из-за того что NSURLSession проксирует через занятый Private Relay-канал.

**Signal:**
- В Data log видим `mask.icloud.com` и `gateway.icloud.com` — это маркер, что iOS сам пытается ходить через свои relay'и.
- Симптом «no internet» при visually-routing-через-proxy.

**Verify:**
1. iOS `Settings → [Apple ID] → iCloud → Private Relay` — выключить.
2. iOS `Settings → Wi-Fi → (i) рядом с сетью → Limit IP Address Tracking` — выключить.
3. iOS `Settings → Cellular → Cellular Data Options → Limit IP Address Tracking` — выключить.
4. Перезапустить Shadowrocket VPN.
5. Повторить тест.

**Fix:** иногда достаточно временно выключить эти три тоггла. Если работает — это диагноз; затем решить, оставлять выключенными постоянно (security trade-off) или искать способ сосуществования (см. §5 Path B).

**Cost:** 30 секунд проверки.

---

### H2 — Positional `.conf` не парсит username/password 🔴 ВЫСОКАЯ

**Severity:** высокая. Surge-syntax `Type = https, host, port, USER, PASS` поддерживается не всеми Shadowrocket-билдами; keyword-форма с явно названными auth-полями — официальный документированный путь.

**Механика:**
- `iphone-1-shadowrocket-positional.conf` (то что используется сейчас):
  ```
  iphone-1-https-proxy = https, <host>, 443, <user>, <pass>, method=connect, tls=true, tfo=false
  ```
- Если Shadowrocket parser ожидает `username=`/`password=` keyword-style, то `<user>` интерпретируется как неизвестный позиционный аргумент → игнорируется → Shadowrocket делает CONNECT без Proxy-Authorization → Squid `407` → Shadowrocket прерывает upstream-соединение → Data log показывает «routed» (потому что Shadowrocket принял routing decision), но фактический tunnel не открыт.

**Signal:**
- Squid log при попытке iPhone должен показать `407 Proxy Authentication Required` или `NONE_NONE/407` или `TCP_DENIED/407`.
- В keyword-форме (`iphone-1-shadowrocket.conf`) тот же тест должен дать `TCP_TUNNEL/200`.

**Verify:**
1. Удалить из Shadowrocket текущий profile `iphone-1-https-proxy`.
2. Импортировать `iphone-1-shadowrocket.conf` (keyword вариант).
3. Параллельно `tail -f` Squid access log.
4. Открыть http://neverssl.com.
5. Если в логе появляется `TCP_TUNNEL/200 CONNECT neverssl.com:80` — это H2.

**Fix:** Использовать keyword вариант `iphone-1-shadowrocket.conf` или один из QR'ов с явно заданным auth secret в URL form (`iphone-1-shadowrocket-https.txt`).

**Cost:** 1 минута переимпорта.

---

### H3 — Profile import создал Server List entry, но активный VPN tunnel держит старый ссылочный server 🟡 СРЕДНЯЯ

**Severity:** средняя, но это classic Shadowrocket gotcha — особенно при импорте через `shadowrocket://add/...` URL и через `.conf`.

**Механика:**
- Shadowrocket держит активный tunnel с конкретным server-объектом. Импорт нового profile создаёт второй server в списке. UI показывает «выбран» зелёной точкой, но tunnel продолжает работать со старым.
- Симптом: Data log показывает routing «через iphone-1-https-proxy», но фактически пакеты идут через предыдущий server (например, прошлый Channel B test, или просто пустой).

**Signal:**
- В Squid логе вообще нет упоминания iPhone source IP (даже 407).
- В stunnel логе нет TLS handshake от iPhone source IP.

**Verify:**
1. Shadowrocket: тапнуть кнопку Connect выкл/вкл (force toggle).
2. Если не помогло: `Home Screen → Settings → VPN → Status: Not Connected`, потом снова через Shadowrocket Connect.
3. Если не помогло: убить Shadowrocket из app switcher, открыть заново, Connect.

**Fix:** force-rebuild VPN tunnel.

**Cost:** 10 секунд.

---

### H4 — TLS-in-TLS, iOS отвергает outer cert validation 🟡 НИЗКАЯ-СРЕДНЯЯ

**Severity:** низкая (curl на Mac работает с тем же cert, а Mac использует тот же trust store что iOS), но **возможна** в edge-cases:
- Cert renewed недавно, OCSP stapling не успел обновиться, iOS strict-checks отверг.
- LE intermediate в цепочке (`R10`/`R11`) ещё не достиг iOS root-обновления.
- ATS (App Transport Security) с pinning требует более строгих параметров cert.

**Signal:**
- stunnel log показывает `SSL accept error: ...` или `SSL_ERROR_SSL` сразу при попытке.
- Curl на Mac работает (если у вас macOS 14+, trust store ≈ iOS).

**Verify:**
1. С Mac: `openssl s_client -connect <host>:443 -servername <host> -showcerts` — посмотреть chain.
2. Сравнить SHA256 leaf cert и intermediate с тем что в Caddy live storage.
3. Проверить Caddy reload status: `systemctl status caddy` + `journalctl -u caddy --since '30min ago' | grep -i cert`.
4. iPhone Safari (без Shadowrocket): `https://<host>` — открывается ли? Выдаёт ли cert error?

**Fix:**
- Если cert проблема — `certbot/Caddy renew` принудительно, перезапустить stunnel чтобы перечитал.
- Альтернатива: вынести cert в shared filesystem и hardlink, или использовать Caddy as-server-for-stunnel-via-unix-socket.

**Cost:** 5-10 минут.

---

### H5 — IPv6 leak / dual-stack mismatch 🟡 СРЕДНЯЯ

**Severity:** средняя на iOS LTE, особенно если LTE-сеть IPv6-prefer, а профиль `ipv6 = false`.

**Механика:**
- Profile содержит `ipv6 = false` — Shadowrocket пытается отключить v6 routing внутри tunnel.
- Но если iOS NE leaks v6 для системных запросов (DNS AAAA, push), они уходят DIRECT в LTE → утекают / зависают.
- Outer TLS к proxy идёт по v4 (потому что host рекордится с A). Но если iOS приоритизирует v6 (Happy Eyeballs), и proxy host имеет AAAA, может уйти на v6 → v6 не routing'ится Shadowrocket'ом → timeout.

**Signal:**
- `dig AAAA <channel_c_naive_public_host>` — есть ли v6?
- iOS Wi-Fi/LTE IPv6 enabled?

**Verify:**
1. `dig AAAA <host>` с любого resolver'а — если AAAA есть, это потенциальный путь утечки.
2. На VPS `ip -6 addr` — IPv6 binding'и Caddy на :443?
3. Если AAAA есть и проблема воспроизводится — временно убрать AAAA из DNS.

**Fix:**
- Убрать AAAA для proxy host из DNS.
- Или гарантировать что Caddy v6-bound :443 тоже идёт через layer4 SNI route.

**Cost:** 5 минут.

---

### H6 — Squid `Safe_ports`/`SSL_ports` слишком узкий для real-world traffic 🟡 НИЗКАЯ-СРЕДНЯЯ

**Severity:** низкая для основных HTTPS сайтов (port 443 в SSL_ports), но возможна для:
- HTTP/3 откатывающийся через 443 (но это UDP, не идёт через TCP CONNECT)
- WebSockets на не-443 портах
- Apple endpoints типа courier.push.apple.com:5223 (port 5223 в acl — OK)
- Firebase / FCM на нестандартных портах

**Текущий ACL:**
```
acl SSL_ports port 443 5222 5223 853 993 995
acl Safe_ports port 80 443 5222 5223 853 993 995
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
```

**Signal:**
- В Squid log: `TCP_DENIED/403` или `TCP_DENIED/400` для CONNECT-запросов на нестандартные порты.

**Verify:**
- Открыть приложение, проверить Squid log на `403/400`.

**Fix:**
- Расширить SSL_ports: добавить 8443, 2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096 (Cloudflare alt-HTTPS), 5228 (FCM), 4070 (Spotify), и т.д.
- Или ослабить: `acl SSL_ports port 1-65535` (NOT recommended security-wise, но diagnostic).

**Cost:** 5-15 минут (нужно знать целевые приложения).

---

### H7 — `bypass-system = true` отрезает слишком много 🟡 НИЗКАЯ

**Severity:** низкая для browser-traffic, средняя для iOS «system services».

**Механика:**
- `bypass-system = true` означает что system-level traffic (NSURLSession без app context, push services, captive portal checks, NTP, system DNS) идёт DIRECT, минуя tunnel.
- В правильной HTTPS-proxy конфигурации это OK — system services не должны проксироваться (они часто требуют v6, UDP, peer-to-peer).
- Но если iOS захардкодил какую-то app в «system» категорию, она тоже bypass'нется. В частности, новые версии iOS считают «sandboxed networking» некоторых приложений system-level.

**Signal:**
- Конкретный browser работает, конкретный app — нет.
- Для browser в Safari работает, в Firefox нет (или наоборот).

**Verify:**
- Поменять профиль на `bypass-system = false` (заставить ВСЁ через tunnel) → если интернет вернулся, виноват bypass-system.

**Fix:** `bypass-system = false`. Trade-off: iOS captive portal detection может зависнуть на Wi-Fi с captive page (для LTE не релевантно).

**Cost:** 1 минута.

---

### H8 — DNS resolution issue (system DNS poisoned/blocked) 🟡 НИЗКАЯ

**Severity:** низкая для HTTPS-proxy с FINAL,PROXY (т.к. hostname идёт в CONNECT), но возможна:
- Shadowrocket DNS sniffing для rule matching резолвит hostname через system DNS до отправки CONNECT.
- LTE operator DNS блокирует/RST для определённых hostname (особенно mask.icloud.com, gateway.icloud.com).
- Profile имеет `dns-server = system` + `fallback-dns-server = system` — оба системные.

**Signal:**
- HTTP-only test (neverssl.com) работает (DNS-resolved on server-side через Squid).
- HTTPS test для конкретных hostname не работает.

**Verify:**
- `dns-server = 1.1.1.1, 8.8.8.8` в profile, переимпорт.

**Fix:**
- Использовать `dns-server = 1.1.1.1, 8.8.8.8` или DoH provider URL.
- Или в profile добавить `dns-direct = false` (если поддерживается) чтобы DNS шёл через tunnel.

**Cost:** 1-2 минуты.

---

### H9 — MSS/MTU на LTE для TLS-in-TLS overflow 🟡 НИЗКАЯ

**Severity:** низкая, но возможна на LTE с MTU < 1428.

**Механика:**
- Outer TLS оверхед ~30 байт. Inner TLS ещё ~30. Если inner-TLS-record близок к outer MSS, он фрагментируется.
- LTE MTU обычно 1428-1500. iOS на LTE clamps по умолчанию.
- Stunnel/Squid не делает MSS clamp на upstream → может быть несоответствие.

**Signal:**
- Малые HTTP запросы работают (handshake, headers).
- Большие responses (картинки, JS bundles) hang/timeout.

**Verify:**
- Открыть `https://neverssl.com` (HTTP) → работает?
- Открыть `https://example.com` (минимальный HTML) → работает?
- Открыть `https://github.com` (большой response) → timeout?

**Fix:**
- На VPS: `iptables -t mangle -A POSTROUTING -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu` (для исходящих от Squid).
- Или поднять MSS в LTE-side router-level clamp.

**Cost:** 5 минут.

---

### H10 — Caddy L4 SNI route mismatch 🟡 НИЗКАЯ

**Severity:** очень низкая (curl на Mac работает значит SNI matching корректный), но edge-case:
- iPhone на LTE может попасть в DPI который заменяет SNI (РКН недавно начал ESNI/ECH-stripping в exp-mode).
- В редких случаях Shadowrocket может не выставить SNI correctly если профиль некорректный.

**Signal:**
- В stunnel log нет TLS handshake от iPhone source IP, но в pcap есть TCP SYN на :443.
- В Caddy access log видна строка с другой SNI.

**Verify:**
- pcap WAN-side, посмотреть TLS Client Hello, проверить SNI extension.
- `tcpdump -ni any -X 'tcp port 443 and (tcp[((tcp[12:1] & 0xf0) >> 2):4] = 0x16030103)'` (пример).

**Fix:** не применимо если Caddy SNI route корректный — это диагностический шаг.

**Cost:** 10 минут (нужен pcap).

---

### H11 — stunnel `TIMEOUTclose = 0` агрессивно рвёт connections 🟡 НИЗКАЯ

**Severity:** низкая, но известный stunnel issue.

**Механика:**
- `TIMEOUTclose = 0` означает «не ждать TLS close_notify». На stunnel close TCP сразу.
- Если iPhone/Shadowrocket посылает TLS close_notify в одном направлении (half-close) перед получением полных данных → stunnel рвёт оба → Shadowrocket видит «connection reset» → retry → fail.

**Signal:**
- В stunnel log видны `connection closed: ...` сразу после установления.
- Очень короткие byte-counts на Squid log: TCP_TUNNEL/200 но bytes=0 или <100.

**Verify:**
- `grep "channel-c" /var/log/stunnel4/channel-c.log | tail -50` после iPhone попытки.

**Fix:** убрать `TIMEOUTclose = 0` (т.е. использовать default = 60 сек).

**Cost:** 2 минуты + Ansible re-deploy.

---

### H12 — APNs/iOS critical-services bypass блокирует connection 🟢 ОЧЕНЬ НИЗКАЯ

**Severity:** очень низкая, но: iOS требует APNs (port 5223) live. Если APNs не работает, iOS marks Wi-Fi/Cell как «degraded» и часть apps refuses to use.

**Signal:**
- Только в очень специфических app failures (Telegram refuse to connect).

**Verify:** `curl --proxy https://user:pass@host:443 -v telnet://courier.push.apple.com:5223`. Squid должен пропустить (5223 в SSL_ports).

**Fix:** не нужен если 5223 разрешён.

---

### H13 — Shadowrocket UDP/QUIC fall-through 🟢 НИЗКАЯ

**Severity:** низкая.

**Механика:** HTTPS proxy не tunnels UDP. QUIC (HTTP/3) не работает через CONNECT. Shadowrocket должна fallback на TCP/HTTPS, но может зависнуть в timeout перед fallback'ом для каждого первого запроса к hostname.

**Signal:** медленный first-load, потом работает.

**Verify:** в Shadowrocket settings → отключить QUIC.

**Fix:** profile уже `bypass-system = true`, но можно добавить `udp-policy = direct` или явный block QUIC.

---

## 4. Diagnostic protocol — пошагово

Цель: за 15-30 минут локализовать причину в одной из 13 гипотез.

### Step 0 — Baseline collection (must-do, всё остальное без него — догадки)

**На MacBook (VPS-side log streaming):**

```bash
ssh deploy@<vps> '
  echo "=== SQUID ===";
  sudo tail -f /var/log/squid/channel-c-access.log &
  echo "=== STUNNEL ===";
  sudo tail -f /var/log/stunnel4/channel-c.log &
  wait
' 2>&1 | tee /tmp/channel-c-attempt-$(date +%H%M).log
```

Не выходить из этого окна. Все следующие шаги — параллельно с running tail.

### Step 1 — Plain HTTP test (различает proxy vs TLS-in-TLS)

iPhone Safari: `http://neverssl.com`

**Ожидаемые исходы:**
- Открывается → outer TLS + CONNECT работают, проблема только в inner-TLS-в-tunnel или в iOS-specific-network-feature → переход к Step 4.
- Не открывается, но в Squid log видим `TCP_TUNNEL/200 CONNECT neverssl.com:80` → tunnel ok, но bytes=0 / data не идут → H11 (stunnel half-close) или iOS NE issue.
- Не открывается, в Squid log `407` → **H2 (auth не передаётся)**.
- Не открывается, в Squid log пусто, в stunnel log SSL error → H4 (cert) или H10 (SNI).
- Не открывается, в Squid log пусто, в stunnel log пусто → H3 (профиль не активен) или H1 (Private Relay перехватил).

### Step 2 — Re-import keyword profile (тест H2)

1. Shadowrocket → Settings → удалить все импортированные servers с именем `iphone-1-https-proxy`.
2. Через Files app или scp импортировать `iphone-1-shadowrocket.conf` (НЕ `-positional`).
3. Tap profile, проверить fields: должны быть `Address: <host>`, `Port: 443`, `Username: <user>`, `Password: <pass>`, `Method: CONNECT`, `TLS: ON`.
4. Connect.
5. Step 1 повторить.

Если переключение с positional на keyword устранило проблему → H2 confirmed.

### Step 3 — iCloud Private Relay / IP Tracking off (тест H1)

Settings:
- `[Apple ID] → iCloud → Private Relay` → OFF
- `Wi-Fi → (i) → Limit IP Address Tracking` → OFF (для текущей сети)
- `Cellular → Cellular Data Options → Limit IP Address Tracking` → OFF
- Reboot iPhone (не обязательно, но рекомендую — частично кеширует policy).

Step 1 повторить.

### Step 4 — Force VPN tunnel rebuild (тест H3)

Shadowrocket: Connect toggle OFF → wait 5s → Connect ON.
Если всё ещё нет: kill app from switcher, reopen, Connect.

### Step 5 — Cross-device test (изолировать iPhone-specific)

На Mac или другом устройстве (iPad с тем же профилем, или браузер с FoxyProxy / Proxifier):

```bash
u="$(tr -d '\n' < ansible/out/clients-channel-c/iphone-1-shadowrocket-https.txt)"
curl -fsS --max-time 20 --proxy "$u" https://api.ipify.org
```

Если работает → проблема iOS/Shadowrocket-specific → H1, H3, H5 наиболее вероятны.

### Step 6 — pcap WAN-side (если логи молчат)

```bash
ssh deploy@<vps> '
  sudo timeout 60 tcpdump -ni any \
    "(tcp port 443 or tcp port 18443 or tcp port 18889)" \
    -w /tmp/channel-c-iphone.pcap
'
scp deploy@<vps>:/tmp/channel-c-iphone.pcap .
# Открыть в Wireshark, фильтр: tls.handshake.extensions_server_name == "<host>"
```

Что искать:
- TLS Client Hello от iPhone source IP с правильным SNI?
- ALPN extension содержит `h2`? (если да — может конфликт с Squid HTTP/1.1).
- TLS handshake завершился (Application Data) или прервался?

### Step 7 — Built-in connectivity test

Shadowrocket → Servers list → tap on `iphone-1-https-proxy` → tap test (стрелка/ping иконка).

Должно показать latency (ms) или error. Error код / message укажет точку отказа.

### Step 8 — Поменять backend на tinyproxy (compare-against-known-good)

```bash
cd ansible
# Edit secrets/stealth.yml (vault):
#   vault_channel_c_naive_backend: stunnel_tinyproxy
ansible-playbook playbooks/10-stealth-vps.yml --tags channel_c
```

Если с tinyproxy iPhone работает, а с Squid нет → проблема в Squid-specific behavior (H6, H8, или ACL).

---

## 5. Solution paths

### Path A — Profile format fix (cheapest, target: H2)

Если diagnostic Step 2 показывает что keyword form работает — закрепляем это:

1. В `docs/client-profiles.md` (или новом mobile-config-guide) явно прописать: «Use `<name>-shadowrocket.conf` (keyword form). The `-positional.conf` is provided for completeness but Shadowrocket parser may ignore credentials.»
2. Удалить positional generation из `30-generate-client-profiles.yml` (или оставить с warning).
3. Регенерировать QR-индексы только с keyword вариантами top-level.

**Файлы:** `ansible/playbooks/30-generate-client-profiles.yml`, `docs/client-profiles.md`.
**Effort:** 30 минут.

### Path B — iOS settings & Shadowrocket UX guide (target: H1, H3)

Создать `docs/channel-c-ios-app-checklist.md` со скриншотами/pathway'ами:

```
Pre-flight checklist for Shadowrocket Channel C profile:

[ ] Settings → [Apple ID] → iCloud → Private Relay: OFF
[ ] Settings → Wi-Fi → (i) → Limit IP Address Tracking: OFF
[ ] Settings → Cellular → Cellular Data Options → Limit IP Address Tracking: OFF
[ ] Shadowrocket → Settings → Connection → IPv6: OFF
[ ] Shadowrocket → Settings → DNS:
      - DNS Server: 1.1.1.1, 8.8.8.8 (NOT system)
      - Fallback DNS: 1.1.1.1
[ ] Profile imported via .conf file (keyword form, not positional)
[ ] Force VPN cycle: Connect OFF → 5s → Connect ON after every profile change
[ ] Verify: Built-in test in Server list shows green latency
```

**Файлы:** `docs/channel-c-ios-app-checklist.md` (new).
**Effort:** 1 час (включая скриншоты, если делать всерьёз).

### Path C — Server-side TLS / cert hardening (target: H4, H11)

1. Stunnel: убрать `TIMEOUTclose = 0` (default 60s — лучше).
2. Stunnel: явно указать `sslVersion = TLSv1.2:TLSv1.3`, `ciphers = HIGH:!aNULL:!MD5`.
3. Verify cert chain ok: Caddy reload hook → stunnel SIGHUP → перечитать cert.
4. Логирование: stunnel `debug = info` (не notice) на debug-период.

**Файлы:** `ansible/roles/caddy_l4/templates/channel-c-stunnel.conf.j2`, `ansible/roles/caddy_l4/handlers/main.yml`.
**Effort:** 30 минут.

### Path D — Squid widening & instrumentation (target: H6)

1. Расширить `SSL_ports`/`Safe_ports` для большего числа портов:
   ```
   acl SSL_ports port 443 853 993 995 5222 5223 5228 8443 2053 2087
   ```
2. Squid logging: `debug_options ALL,3` на debug-период (verbose, для прода — обратно `ALL,1`).
3. Health: добавить в `99-verify.yml` тест: `curl --proxy ... https://api.ipify.org` и assert HTTP 200.

**Файлы:** `ansible/roles/caddy_l4/templates/channel-c-squid.conf.j2`, `ansible/playbooks/99-verify.yml`.
**Effort:** 1 час.

### Path E — Architecture: drop Squid, use sing-box HTTP-CONNECT inbound

**Если H1-H8 закрыты, а проблема всё ещё voodoo'ит — менять backend.**

Sing-box (already known по Channel A) поддерживает `naive` inbound с встроенной поддержкой HTTP CONNECT с TLS. Это устраняет:
- два процесса (stunnel + Squid) в пользу одного.
- TLS terminate edge cases.
- htpasswd / basic_ncsa_auth проблемы (sing-box hardcodes auth).
- TIMEOUTclose-style edge cases.

**Trade-off:** sing-box на VPS — ещё один runtime, новый Ansible role. Но топология та же: Caddy L4 SNI → sing-box `:18443` → naive-listen.

См. §6 ChC-Alt-1 ниже.

**Effort:** 4-6 часов (Ansible role + tests).

---

## 6. Architectural alternatives — если Channel C системно хрупкий

Channel C задумывался как «manual mobile fallback с маскировкой под обычный HTTPS-сайт». Если HTTPS-proxy через Squid/stunnel остаётся капризным — есть 5 архитектурных альтернатив, в порядке возрастания радикальности.

### ChC-Alt-1 — Replace Squid+stunnel with sing-box `naive` inbound

```yaml
sing-box on VPS:
  inbound:
    - type: naive
      listen: 127.0.0.1
      listen_port: 18443
      users:
        - user_name: USER
          auth_secret: PASS
      tls:
        enabled: true
        certificate_path: /var/lib/caddy/certificates/.../host/host.crt
        key_path:        /var/lib/caddy/certificates/.../host/host.key
        alpn: ["h2", "http/1.1"]
```

Caddy L4 SNI → `127.0.0.1:18443` (sing-box) → CONNECT-handle.

**Плюсы:** один процесс, проверенный mobile-side support, ALPN правильно negotiate'ится, нет stunnel-edge-cases.
**Минусы:** новая Ansible role, секреты в конфиге sing-box.

### ChC-Alt-2 — VLESS + TLS + WebSocket (battle-tested mobile)

```
iPhone (Shadowrocket) ←→ wss://channel-c.host:443/path ←→ Caddy reverse_proxy ←→ Xray VLESS+WS+TLS
```

**Плюсы:**
- Shadowrocket имеет first-class support для VLESS+WS+TLS.
- WS-через-TLS = выглядит как обычная WebSocket-апликация (Discord, Slack).
- Нет CONNECT-проблем с парсингом auth.
- UUID-based auth, не username/password — не подвержен positional/keyword issues.

**Минусы:**
- Concept-overlap с Channel B (XHTTP). Решение: Channel B = XHTTP (новее, h2/h3), Channel C = WS (older, более compatible).
- Нужен Xray VLESS+WS instance.

**Effort:** 3-4 часа (Xray instance + Caddy reverse_proxy WS path).

### ChC-Alt-3 — Trojan / Trojan-go

Trojan = TLS+password authentication, выглядит как HTTPS-сайт, mobile clients (Shadowrocket / Stash / Surge) — все поддерживают.

**Плюсы:**
- Очень mobile-friendly, протокол был дизайн'нут для anti-DPI на mobile.
- Простой server (single binary, single config).

**Минусы:**
- Старее VLESS, fewer best-practices в active development.
- Authentication = single password (less granular than per-client UUID).

**Effort:** 2-3 часа.

### ChC-Alt-4 — sing-box на iPhone напрямую (skip Shadowrocket)

iPhone установить official `sing-box` app (если доступен в App Store) или TestFlight build → импортировать `iphone-N-sing-box-outbound.json` напрямую (он уже генерируется в `30-generate-client-profiles.yml`).

**Плюсы:**
- Один и тот же engine на сервере и клиенте — никаких parsing/format mismatches.
- naive outbound поддерживается нативно.

**Минусы:**
- sing-box iOS — не такой polished UX как Shadowrocket.
- Другой App Store account возможно нужен.

**Effort:** 0 (артефакт уже есть в `ansible/out/clients-channel-c/<name>-sing-box-outbound.json`). Только тестирование.

### ChC-Alt-5 — Drop Channel C; redesign as parallel Reality with different SNI

Если HTTPS-proxy approach остаётся хрупким, а пользователь хочет fallback — можно **не делать новый протокол**, а развернуть **второй Reality на другой :443 (alt port) или другом VPS** с другим SNI. Тогда профиль mobile = ровно как Channel A (известно работает), только server URL другой.

**Плюсы:**
- Тот же proven протокол, минимум новых рисков.
- Одна точка обслуживания (Reality везде).

**Минусы:**
- Не диверсификация по протоколу — если Reality глобально DPI'нется, оба канала упадут.
- Channel A и Channel C становятся «два экземпляра» а не «два разных способа».

**Effort:** 2-3 часа на второй Reality instance.

---

## 7. Recommended order — что делать первым

Цена/польза матрица:

| Шаг | Cost | Probability of being root cause | Action priority |
|---|---|---|---|
| **0. Squid log tail + iPhone retry** | 5 min | 100% (диагностика) | **Прямо сейчас** |
| **1. Step 1 plain HTTP (neverssl.com)** | 1 min | разделит ветки на 4 части | **Прямо сейчас** |
| **2. Step 3 iCloud Private Relay OFF** | 1 min | ~40% (H1) | Сразу после 0+1 |
| **3. Step 2 keyword profile** | 2 min | ~30% (H2) | Если 2 не помогло |
| **4. Step 4 force VPN cycle** | 30 sec | ~10% (H3) | После 3 |
| **5. Step 5 cross-device test** | 5 min | изолирует iOS-specific | После 1-4 если не понятно |
| **6. Step 8 backend swap to tinyproxy** | 10 min | изолирует Squid-specific | Если 1-5 не дали ответа |
| **7. Step 6 pcap WAN-side** | 15 min | покажет любую TLS/SNI проблему | Если всё остальное провалилось |
| **8. ChC-Alt-1 sing-box naive inbound** | 4-6 hours | архитектурное решение | Если 7 показал что Squid/stunnel inherent проблема |
| **9. ChC-Alt-2 VLESS+WS+TLS** | 3-4 hours | архитектурный pivot | Если HTTPS-proxy подход признан слишком fragile |

**Конкретно прямо сейчас:**

1. Запустить tail -f Squid+stunnel в одном окне.
2. На iPhone: открыть `http://neverssl.com` (HTTP, не HTTPS).
3. Если в Squid логе появилось `TCP_TUNNEL/200 CONNECT neverssl.com:80` — большинство веток отбрасывается, проблема в TLS-in-TLS или iOS NE; перейти к H1/H4/H11.
4. Если ничего нет в логе — проблема в outer TLS handshake; перейти к H3/H4/H10.
5. Если 407 — H2 (auth); переимпорт keyword.

---

## 8. Critical files (если потребуется code change)

| Файл | Назначение в каждом фиксе |
|---|---|
| `docs/channel-c-shadowrocket-debug-research-2026-04-27.md` | Сам этот research-документ (NEW) |
| `docs/channel-c-ios-app-checklist.md` | Pre-flight checklist для iOS клиента (Path B, NEW) |
| `ansible/playbooks/30-generate-client-profiles.yml` | Удаление positional варианта, top-level keyword только (Path A) |
| `ansible/roles/caddy_l4/templates/channel-c-stunnel.conf.j2` | Убрать `TIMEOUTclose = 0`, добавить explicit TLS protocols (Path C) |
| `ansible/roles/caddy_l4/templates/channel-c-squid.conf.j2` | Расширить SSL_ports, debug_options (Path D) |
| `ansible/playbooks/99-verify.yml` | Add functional curl-test для channel C (Path D) |
| `ansible/group_vars/vps_stealth.yml` | Toggle backend `stunnel_squid` ↔ `stunnel_tinyproxy` для diagnostic A/B |
| `docs/client-profiles.md` | Reference на новый ios-checklist |

---

## 9. Verification (как понять что починили)

Definition of fixed:

1. iPhone Shadowrocket подключен к `iphone-1-https-proxy`.
2. На iPhone Safari `https://api.ipify.org` показывает VPS public IP (а не iPhone LTE NAT IP).
3. Squid access log показывает `TCP_TUNNEL/200 CONNECT api.ipify.org:443 ... HIER_DIRECT/<vps-ip>` с iPhone source IP.
4. Bytes columns в Squid log — non-zero (>5000 для типичной HTTPS-сессии с full TLS handshake + handshake response + 1 round-trip data).
5. Channel A ДО и ПОСЛЕ fix `verify.sh` — green.
6. Stunnel log — без `SSL_ERROR` записей.
7. (Optional) speedtest через `iphone-1-https-proxy` — реальная пропускная.

Acceptance test командой:

```bash
# С iPhone: open Safari, https://api.ipify.org → запомнить IP
# С Mac: curl ifconfig.me → сравнить, должен совпасть с тем что показал iPhone
# На VPS:
ssh deploy@<vps> 'sudo grep "$(date +%H:%M)" /var/log/squid/channel-c-access.log | grep "TCP_TUNNEL/200" | tail -10'
# должно быть >0 entries и ненулевые байты
```

---

## 10. Decision matrix — что менять, что не трогать

| Решение | Когда | Когда НЕ |
|---|---|---|
| Path A (profile format) | Если H2 (auth) подтверждён | Если auth и так работает |
| Path B (iOS checklist) | Всегда (создать как permanent doc) | Никогда не «не делать» |
| Path C (stunnel/cert) | Если H11 / H4 подтверждены | Если Squid log чистый |
| Path D (Squid widen) | Если H6 / H8 подтверждены | Если все CONNECT запросы выходят TCP_TUNNEL/200 |
| Path E (sing-box naive) | Если 2+ из {H4, H6, H11} hit, или Squid/stunnel замусорены | Если простой fix закрыл проблему |
| Alt-1 (sing-box naive) | Когда инфра упрощения нужна | Когда текущая работает |
| Alt-2 (VLESS+WS) | Когда HTTPS-proxy подход признан архитектурно ломким | Без явного сигнала |
| Alt-4 (sing-box на iPhone) | Если Shadowrocket конкретно — bottleneck | Если sing-box iOS UX неприемлем |
