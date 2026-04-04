# Диагностика проблем

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

---

## Авто-добавленный домен не работает или добавился лишний

### Симптом

Домен был автоматически добавлен в VPN, но не должен был (или наоборот — нужный не добавился).

### Диагностика

```bash
# Проверить все авто-добавленные домены
./scripts/domain-report --all

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
4. Чтобы убрать уже добавленный домен немедленно: `./scripts/domain-report --reset` (удалит **все** авто-добавленные), затем cron добавит остальные обратно при следующем запуске

### Нужный домен не добавляется

Возможные причины:

- **Устройство не использует роутер как DNS** — проверьте DNS-настройки устройства
- **Домен в SKIP_PATTERNS** — CDN/инфраструктурные паттерны пропускаются намеренно
- **Домен совпадает с Russian TLD** — проверьте: `.ru`, `.su`, `.рф`, `.москва`, `.tatar`, `.moscow`
- **Домен не в реестре РКН и не проходит ISP-пробу** — обычные кандидаты скрипт тестирует через ISP после `≥3` запросов, а короткие/`www`-входные домены может проверить раньше. Если сайт доступен через ISP (HTTP не `000`) — он не добавляется. Добавьте вручную
- **DNS-лог не пишется** — проверьте `ls /opt/var/log/dnsmasq.log` и что `ENABLE_DNSMASQ_LOGGING=1` в `.env`
- **domain-auto-add.sh не запускается** — проверьте `cru l | grep DomainAutoAdd`, перезапустите `services-start`
- **Добавьте вручную** через `configs/dnsmasq.conf.add` + `configs/dnsmasq-vpn-upstream.conf.add` + `./deploy.sh`

### Домен попал в GEO-BLOCKED, но не должен

ISP-проба иногда даёт ложные срабатывания (временный таймаут сервера). Чтобы исключить домен:

1. Добавьте в `configs/domains-no-vpn.txt`
2. Запустите `./deploy.sh`
3. Если домен уже в `dnsmasq-autodiscovered.conf.add` — вручную удалите строки или сделайте `--reset`

## Общие команды диагностики

```bash
# Состояние роутинга
ip rule show | grep -E '0x1000|1\.1\.1\.1|9\.9\.9\.9'
ip route show table wgc1

# Состояние ipset
ipset list VPN_DOMAINS | wc -l        # количество записей
ipset list VPN_STATIC_NETS            # статические подсети

# DNS-тест
nslookup google.com 127.0.0.1

# Проверка маршрута для конкретного IP
ip route get 142.250.74.206           # Google
ip route get 149.154.167.1            # Telegram DC
```

## Связанные документы

- [architecture.md](architecture.md) — как устроена маршрутизация
- [getting-started.md](getting-started.md) — настройка с нуля
- [telegram-deep-dive.md](telegram-deep-dive.md) — подробности по Telegram
