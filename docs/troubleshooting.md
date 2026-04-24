# Диагностика проблем

## Сначала: быстрый health check

Перед точечной диагностикой почти всегда полезно начать с:

```bash
./verify.sh
./scripts/router-health-report
```

Как это читать:

- `Routing Health`
  показывает, на месте ли repo-managed hooks, `ip rule`, `RC_VPN_ROUTE`, DNS redirect для `wgs1`
- `Catalog Capacity`
  показывает, не разросся ли `VPN_DOMAINS` и сколько headroom осталось
- `Growth Trends`
  показывает, есть ли заметный рост каталога и не стал ли auto-catalog его главным источником
- `Freshness`
  показывает, насколько свежи blocked-list, ipset persistence и traffic snapshots
- `Drift`
  показывает только missing repo-managed invariants, а не “всё подряд отличается”

Если нужно сохранить понятный sanitised snapshot для себя или следующей LLM:

```bash
./scripts/router-health-report --save
```

Он обновит:

- tracked `docs/router-health-latest.md`
- local `docs/vpn-domain-journal.md`
- router-side USB-backed copy в `/opt/var/log/router_configuration/reports/`

## Сайт не идёт через VPN

### Симптом

Сайт из списка открывается напрямую (без VPN) или не открывается вовсе.

### Диагностика

```bash
# 1. Проверяем, что домен резолвится через dnsmasq
nslookup example.com 127.0.0.1

# 2. Проверяем, что IP попал в ipset
ipset list VPN_DOMAINS | grep <IP_из_шага_1>

# 3. Проверяем, что маршрут ведёт через wgc1
ip route get <IP_из_шага_1>
# Ожидаем: ... dev wgc1 ...
```

### Возможные причины

- **Домен не в конфиге** — проверьте `configs/dnsmasq.conf.add`
- **DNS upstream не настроен** — проверьте `configs/dnsmasq-vpn-upstream.conf.add`
- **ip rule отсутствуют** — проверьте `ip rule show | grep 0x1000`
- **WGC1 не подключен** — проверьте `ip route show table wgc1`

## Tailscale Exit Node меняет внешний IP, но заблокированные сайты всё равно не открываются

### Симптом

На iPhone через `Tailscale Exit Node` внешний IP уже домашний, но `YouTube` и другие заблокированные сервисы по-прежнему не открываются или идут не так, как у локального клиента в Wi-Fi.

### Причина

Трафик `Tailscale Exit Node` генерируется самим роутером, а не приходит как обычный LAN-трафик на `br0`. Если маркировка `VPN_DOMAINS` висит только в `PREROUTING`, split-routing сработает для локальных клиентов, но не для `Exit Node`.

### Диагностика

```bash
# Проверить, что hook для локально сгенерированного трафика есть
iptables -t mangle -S | grep 'OUTPUT -j RC_VPN_ROUTE'

# Проверить, что доменный IP реально в наборе
nslookup youtube.com <router_lan_ip>
ipset test VPN_DOMAINS <IP_из_nslookup>

# Проверить, что такой IP уходит через WGC1 при mark 0x1000
ip route get <IP_из_nslookup> mark 0x1000
# Ожидаем: ... dev wgc1 ...
```

### Решение

- убедитесь, что в `scripts/firewall-start` есть `-A OUTPUT -j RC_VPN_ROUTE`
- выполните `./deploy.sh`
- перезапустите `Tailscale` на клиенте и заново выберите `Exit Node`

## Raw WireGuard server даёт домашний IP, но `VPN_DOMAINS` не срабатывают

### Симптом

На iPhone через raw `WireGuard server` внешний IP уже домашний, интернет идёт через дом, но `YouTube` и другие домены из `VPN_DOMAINS` не повторяют ту же split-routing логику, что у локального клиента в Wi-Fi.

### Причина

Трафик такого клиента приходит на роутер не через `br0`, а через интерфейс `wgs1`. Если hook `RC_VPN_ROUTE` висит только на `PREROUTING -i br0`, split-routing работает для LAN-клиентов, но не для raw `WireGuard server` peer'ов.

### Диагностика

```bash
# Проверить, что hook для raw WireGuard server-клиентов есть
iptables -t mangle -S | grep 'PREROUTING -i wgs1 -j RC_VPN_ROUTE'

# Проверить, что доменный IP реально в наборе
nslookup youtube.com <router_lan_ip>
ipset test VPN_DOMAINS <IP_из_nslookup>

# Проверить, что такой IP уходит через WGC1 при mark 0x1000
ip route get <IP_из_nslookup> mark 0x1000
# Ожидаем: ... dev wgc1 ...
```

### Решение

- убедитесь, что в `scripts/firewall-start` есть `-A PREROUTING -i wgs1 -j RC_VPN_ROUTE`
- выполните `./deploy.sh`
- переподключите raw `WireGuard server` клиент
- проверьте `./scripts/traffic-report`: в разделе `WIREGUARD SERVER PEERS` должны появиться conntrack-записи и дельты peer'а

## Tailscale Exit Node работает, но очень медленно

### Симптом

Через `Exit Node` сайты открываются, но заметно медленнее, чем у локального клиента в Wi-Fi.

### Диагностика

```bash
# Проверить, прямое ли соединение с клиентом
/opt/bin/tailscale status

# Проверить сетевую диагностику Tailscale
/opt/bin/tailscale netcheck

# Пинг клиента внутри tailnet
/opt/bin/tailscale ping <tailscale_ip_клиента>
```

### Возможные причины

- **Соединение ушло в `DERP/relay`** — в `tailscale status` вместо `direct ...` видно `relay "hel"` или другой DERP-регион
- **Userspace-режим Tailscale на роутере** — на Merlin это ожидаемо медленнее, чем kernel-mode или обычный LAN-клиент
- **Двойная обработка трафика** — клиент идёт через `Tailscale Exit Node`, а часть доменов потом ещё уходит через `WireGuard wgc1`
- **Мобильная сеть клиента** — на LTE/5G NAT и маршрут могут меняться, из-за чего прямое соединение становится нестабильным

### Практический вывод

Если нужен именно полный интернет через дом и блокировки типа `YouTube`, `Exit Node` остаётся правильным режимом. Но по скорости это компромиссный вариант по сравнению с белым IPv4 и обычным VPN-сервером или с более мощным домашним устройством под `Tailscale`.

## VPN_DOMAINS пуст после перезагрузки

### Симптом

`ipset list VPN_DOMAINS` показывает пустой набор сразу после перезагрузки роутера.

### Диагностика

```bash
# Проверяем, что state-файл существует
ls -la /jffs/addons/router_configuration/VPN_DOMAINS.ipset
# или, если Entware установлен:
ls -la /opt/tmp/VPN_DOMAINS.ipset

# Проверяем cron-задачу
cru l | grep save-ipset
```

### Возможные причины

- **Cron не настроен** — перезапустите `services-start`
- **State-файл не существует** — ещё не было первого сохранения (подождите 6 часов или запустите `cron-save-ipset` вручную)
- **firewall-start не запускается при загрузке** — проверьте, что файл существует и исполняемый: `ls -la /jffs/scripts/firewall-start`

После этого дополнительно проверьте:

```bash
./verify.sh
./scripts/router-health-report
```

Если `Freshness` показывает старый или missing persistence file, это уже быстрее видно в summary, чем по ручным командам.

## SSH connection refused

### Симптом

`deploy.sh` или `verify.sh` не могут подключиться к роутеру.

### Диагностика

```bash
# Проверяем, что роутер доступен
ping <router_ip>

# Проверяем SSH-порт
nc -z -w 5 <router_ip> 22
```

### Возможные причины

- **SSH не включен** — Administration → System → Enable SSH → LAN only
- **Другой порт** — используйте `ROUTER_PORT=<port> ./deploy.sh`
- **Только SSH-ключ, пароль отключен** — убедитесь, что ваш публичный ключ на роутере
- **Firewall на роутере** — проверьте, что подключение идёт из LAN, а не из WAN

## deploy.sh падает с SCP ошибкой

### Симптом

```
scp: Received message too long
```

### Причина

Merlin использует dropbear, у которого SCP-протокол отличается от OpenSSH. Скрипт `deploy.sh` уже использует флаг `scp -O` (legacy SCP protocol) для совместимости.

Если ошибка всё равно появляется, проверьте версию вашего `scp`:

```bash
scp -V
```

Если версия не поддерживает `-O`, обновите OpenSSH или используйте `sftp` вручную.

## Telegram картинки грузятся медленно

### Симптом

Текст в Telegram отправляется нормально, но фото и видео грузятся очень долго.

### Диагностика

```bash
# 1. Проверяем, что статические подсети загружены
ipset list VPN_STATIC_NETS
# Ожидаем: 14+ записей с подсетями Telegram

# 2. Проверяем конкретную подсеть Telegram
ipset test VPN_STATIC_NETS 149.154.167.1
# Ожидаем: is in set

# 3. Проверяем маршрут к Telegram DC
ip route get 149.154.167.1
# Ожидаем: ... dev wgc1 ...
```

### Возможные причины

- **VPN_STATIC_NETS пуст** — проверьте, что `static-networks.txt` загрузился: файл `/jffs/configs/router_configuration.static_nets` должен существовать
- **Подсети устарели** — сравните с актуальным `core.telegram.org/resources/cidr.txt`
- **Нет AS62041-подсетей** — убедитесь, что `5.28.192.0/21`, `5.28.248.0/21`, `95.161.64.0/19` присутствуют
- **DPI на уровне провайдера** — VPN решает проблему DPI, но если WGC1 не подключен, трафик идёт напрямую

Подробнее: [telegram-deep-dive.md](telegram-deep-dive.md)

## WGC1 таблица маршрутизации пуста

### Симптом

```bash
ip route show table wgc1
# пустой вывод
```

### Причина

WireGuard-клиент WGC1 не подключен. Маршруты появляются только при активном подключении.

### Решение

1. Откройте web-интерфейс роутера
2. VPN → VPN Client → WireGuard
3. Подключите профиль WGC1
4. Проверьте заново: `ip route show table wgc1`

## DNS всё ещё отдаёт российские IP

### Симптом

`nslookup example.com` возвращает IP из российского CDN, хотя домен в конфиге.

### Диагностика

```bash
# Проверяем, что upstream DNS правила есть
ip rule show | grep '1\.1\.1\.1'
# Ожидаем: 9901: from all to 1.1.1.1 lookup wgc1

ip rule show | grep '9\.9\.9\.9'
# Ожидаем: 9902: from all to 9.9.9.9 lookup wgc1

# Проверяем, что DNS-трафик идёт через VPN
ip route get 1.1.1.1
# Ожидаем: ... dev wgc1 ...
```

### Возможные причины

- **ip rule не добавлены** — запустите `nat-start` вручную
- **WGC1 не подключен** — маршруты `1.1.1.1` и `9.9.9.9` ведут в пустую таблицу
- **DNS upstream не настроен для этого домена** — проверьте `dnsmasq-vpn-upstream.conf.add`
- **DNS-кэш устройства** — устройство кэширует старый ответ; очистите кэш или подождите TTL

## Авто-добавленные домены есть в файле, но не работают

### Симптом

`domain-report --all` показывает домены, но трафик к ним не идёт через VPN — `nslookup` не добавляет IP в ipset.

### Причина

Merlin автоматически подключает к dnsmasq **только** `/jffs/configs/dnsmasq.conf.add`. Файл `dnsmasq-autodiscovered.conf.add` должен загружаться явной директивой `conf-file=` в конце основного конфига. Если этой строки нет — все авто-добавленные ipset/server правила молча игнорируются.

### Диагностика

```bash
# Проверить, что директива есть в основном конфиге на роутере
grep "conf-file.*autodiscovered" /etc/dnsmasq.conf

# Ожидаем:
# conf-file=/jffs/configs/dnsmasq-autodiscovered.conf.add
```

### Решение

Если строки нет — запустите `./deploy.sh`. Начиная с текущей версии `configs/dnsmasq.conf.add` содержит эту директиву в конце файла.

## verify.sh показывает Warning, но routing вроде работает

### Типичный случай

`verify.sh` сейчас может вернуть `Warning`, даже если основные routing hooks и каталоги живы.

Чаще всего это связано не с поломкой runtime, а с `Freshness`:

- blocked list давно не обновлялся
- traffic snapshots устарели
- `WGS1 snapshot` ещё не накопился как отдельный artifact

### Как отличить harmless warning от реальной поломки

Смотрите в таком порядке:

1. `Routing Health`
   - если всё `OK`, core routing layer на месте
2. `Drift`
   - если пусто, missing repo-managed invariants не найдено
3. `Freshness`
   - warning здесь означает проблему observability, а не обязательно проблему маршрутизации
4. `Growth Trends`
   - если тут только `Stable` / `Stable growth`, warning почти наверняка не связан с runaway catalog growth

Пример:

- `WGS1 snapshot = Missing`
  это warning слоя observability, если отдельный snapshot-файл ещё не накопился на USB-backed storage
  Сам `wgs1` routing при этом может работать нормально
- `WGS1 snapshot = Capability problem`
  это уже не просто отсутствие baseline, а проблема слоя сбора: `wg` binary lookup, runtime `wgs1` или cron execution path
- если одновременно `WG server total` уже ненулевой, а `Top by WG server peers` пуст / `WireGuard peer total = 0.00 GiB`, это обычно означает, что router-wide байты по `wgs1` есть, но per-peer breakdown не из чего собрать
  В новых health/reporting текстах это показывается как `no usable peer baseline`, а не как “peer traffic отсутствует”.

### Что делать

- если routing реально работает, просто сохранить новое состояние:
  ```bash
  ./scripts/router-health-report --save
  ```
- если `WGS1 snapshot` долго остаётся `Missing`, проверьте `/jffs/scripts/cron-traffic-snapshot`: он должен реально писать `wgs1/<timestamp>.dump` и не полагаться на shell builtin lookup для `wg`
- если health/reporting показывает `Capability problem`, проверьте наличие `wg`, существование интерфейса `wgs1` и то, что `wg show wgs1 dump` реально выполняется на роутере
- если warning связан с blocked-list или snapshots, дождитесь следующего cron-run или проверьте соответствующий artifact вручную

---

## Авто-добавленный домен не работает или добавился лишний

### Симптом

Домен был автоматически добавлен в VPN, но не должен был (или наоборот — нужный не добавился).

### Диагностика

```bash
# Проверить все авто-добавленные домены
./scripts/domain-report --all

# Вычистить избыточные child auto-домены
./scripts/domain-report --cleanup

# Проверить лог последних запусков
./scripts/domain-report --log

# Проверить cron-задачу на роутере
cru l | grep DomainAutoAdd
# Ожидаем: 0 * * * * /jffs/addons/x3mRouting/domain-auto-add.sh

# Посмотреть содержимое файла авто-добавленных доменов (через SSH)
cat /jffs/configs/dnsmasq-autodiscovered.conf.add
```

### Лишний домен добавился автоматически

1. Добавьте домен в `configs/domains-no-vpn.txt` (без поддомена, корневое имя):
   ```
   example.com
   ```
2. Запустите `./deploy.sh` — файл будет скопирован на роутер
3. При следующем запуске `domain-auto-add.sh` домен будет пропускаться
4. Если нужно быстро убрать исторический шум из child-записей, сначала выполните `./scripts/domain-report --cleanup`
5. Чтобы убрать уже добавленный домен немедленно целиком: `./scripts/domain-report --reset` (удалит **все** авто-добавленные), затем cron добавит остальные обратно при следующем запуске

### Нужный домен не добавляется

Возможные причины:

- **Устройство не использует роутер как DNS** — проверьте DNS-настройки устройства
- **Домен в SKIP_PATTERNS** — CDN/инфраструктурные паттерны пропускаются намеренно
- **Домен совпадает с Russian TLD** — проверьте: `.ru`, `.su`, `.рф`, `.москва`, `.tatar`, `.moscow`
- **Домен уже покрыт родительским suffix-правилом** — если есть `fbcdn.net`, child-хосты `*.fbcdn.net` больше не пишутся отдельно. Это нормально
- **Домен не в реестре РКН и не проходит ISP-пробу** — проверка идёт по `count24h` и по сигналу user-interest (`count7d` + `active_days7d`). Если сайт доступен через ISP (HTTP не `000`) — он не добавляется. Добавьте вручную
- **Dynamic DNS хосты с IP-encoded family label** — скрипт не должен сворачивать их в общий публичный суффикс, а должен писать семейство по IP-лейблу, например `203-0-113-10.sslip.io`
- **Веб работает, а SSH/другой порт нет** — если IP уже попал в `VPN_DOMAINS`, весь трафик к нему уходит в VPN. Для точечного обхода добавьте `tcp <IP> 22` в `configs/no-vpn-ip-ports.txt` и задеплойте конфиг
- **Через Wi-Fi всё работает, а raw `WireGuard server` client получает `dns resolution failure` или не повторяет `VPN_DOMAINS`** — сначала проверьте, что проблема не в самом туннеле:
  ```bash
  wg show wgs1
  wg show wgs1 dump
  iptables -t nat -L PREROUTING -v -n | egrep 'wgs1|dpt:53|REDIRECT'
  tail -n 100 /opt/var/log/dnsmasq.log | grep '10.6.0.'
  ```
  Если у peer `endpoint=(none)` и `rx/tx=0`, роутер вообще не получает данные от клиента: это не поломка `VPN_DOMAINS`, а клиентский `WireGuard`/peer-state после рестарта сервера. Если трафик через `wgs1` есть, но DNS-запросов от `10.6.0.x` нет, проверьте профиль клиента и DNS внутри туннеля
- **DNS-лог не пишется** — проверьте `ls /opt/var/log/dnsmasq.log` и что `ENABLE_DNSMASQ_LOGGING=1` в `secrets/router.env` (или `.env`)
- **domain-auto-add.sh не запускается** — проверьте `cru l | grep DomainAutoAdd`, перезапустите `services-start`
- **Добавьте вручную** через `configs/dnsmasq.conf.add` + `configs/dnsmasq-vpn-upstream.conf.add` + `./deploy.sh`

### Домен попал в GEO-BLOCKED, но не должен

ISP-проба иногда даёт ложные срабатывания (временный таймаут сервера). Чтобы исключить домен:

1. Добавьте в `configs/domains-no-vpn.txt`
2. Запустите `./deploy.sh`
3. Затем выполните `./scripts/domain-report --cleanup`, чтобы удалить уже накопившиеся child-записи без полного reset
4. Если нужно удалить всё целиком — используйте `./scripts/domain-report --reset`

## Общие команды диагностики

```bash
# Состояние роутинга
ip rule show | grep -E '0x1000|1\.1\.1\.1|9\.9\.9\.9'
ip route show table wgc1

# Состояние ipset
ipset list VPN_DOMAINS | wc -l        # количество записей
ipset list VPN_STATIC_NETS            # статические подсети
ipset list VPN_DOMAINS | sed -n '1,10p'   # header: hashsize / maxelem / memory
ipset list VPN_DOMAINS | awk '/^Number of entries:/ {print $4}'

# DNS-тест
nslookup google.com 127.0.0.1

# Проверка маршрута для конкретного IP
ip route get 142.250.74.206           # Google
ip route get 149.154.167.1            # Telegram DC
```

Дополнительно:

```bash
# Compact health-summary
./verify.sh

# Sanitised Markdown snapshot для человека / LLM
./scripts/router-health-report

# Сохранить состояние в tracked summary + local journal + USB-backed reports
./scripts/router-health-report --save
```

Если `VPN_DOMAINS` заметно растёт:

- До `~10%` лимита `65536` — это комфортный уровень.
- После `>30%` стоит проверить auto-discovery на слишком широкие семейства и CDN-агрегаты.
- Для истории и тренда обновляйте локальный `docs/vpn-domain-journal.md`: там хранится operational snapshot по размеру `ipset`.
- Для tracked sanitised состояния используйте `docs/router-health-latest.md`: его можно безопасно читать из git и передавать LLM.

## Связанные документы

- [architecture.md](architecture.md) — как устроена маршрутизация
- [getting-started.md](getting-started.md) — настройка с нуля
- [telegram-deep-dive.md](telegram-deep-dive.md) — подробности по Telegram
