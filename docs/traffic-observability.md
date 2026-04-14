# Traffic Observability

Этот документ описывает, как проект собирает и интерпретирует сетевые счётчики на роутере, и где именно проходят границы точности.

## Цели

`traffic-report` и `traffic-daily-report` отвечают на 6 практических вопросов:

1. Сколько трафика прошло через внешний канал роутера.
2. Сколько из этого трафика прошло через `WireGuard wgc1`.
3. Сколько трафика прошло через raw `WireGuard server` интерфейс `wgs1`.
4. Какие локальные устройства сейчас активны и сколько у них активных соединений.
5. Сколько байт по `Tailscale` прошло у каждого peer'а.
6. Сколько байт по raw `WireGuard server` прошло у каждого peer'а и какие у него сейчас active conntrack entries.

Скрипты не являются биллинговой системой. Они сочетают:

- накопительные счётчики интерфейсов Linux
- текущий или end-of-day `conntrack`-срез
- peer-статистику `tailscaled`
- peer-статистику `wg show wgs1 dump`

Поэтому часть метрик точная, а часть является live или end-of-day снимком.

## Компоненты

### `scripts/cron-traffic-snapshot`

Запускается на роутере каждые 6 часов через `cru`.

Что сохраняет:

- `wan0`, `wgc1`, `wgs1`, `br0`, `eth6`, `eth7` → `rx_bytes` / `tx_bytes`
- JSON-снимок `tailscale status --json`
- raw-снимок `wg show wgs1 dump`

Куда сохраняет:

- если есть `Entware`: `/opt/var/log/router_configuration`
- иначе: `/jffs/addons/router_configuration/traffic`

Форматы:

- `interface-counters.tsv`
- `tailscale/<timestamp>.json`
- `wgs1/<timestamp>.dump`

Хранение ограничивается:

- до 5000 строк для `interface-counters.tsv`
- до 60 дней для raw `tailscale` JSON snapshots
- до 60 дней для raw `wgs1` dump snapshots

### `scripts/cron-traffic-daily-close`

Запускается на роутере в `23:55`.

Что делает:

1. Делает closing snapshot счётчиков через `cron-traffic-snapshot`.
2. Сохраняет raw `dnsmasq.leases + conntrack` снимок конца дня.

Куда сохраняет:

- `daily/YYYY-MM-DD-lan-conntrack.txt`

Этот файл используется и для локальных устройств из текущего `dnsmasq.leases`, и для remote `WireGuard server` peer'ов из текущего `wgs1` peer-map.

### `scripts/traffic-report`

Локальный CLI-скрипт на рабочей машине.

Что делает:

1. Подключается к роутеру по `ssh`.
2. Забирает текущие счётчики интерфейсов.
3. Забирает history-файл `interface-counters.tsv`.
4. Находит первый snapshot за текущий день.
5. Считает дельты `текущий - базовый`.
6. Забирает текущий `tailscale status --json` и первый snapshot `tailscale` за день.
7. Считает per-peer дельты `Tailscale`.
8. Забирает текущий `wg show wgs1 dump` и первый snapshot `wgs1` за день.
9. Считает per-peer дельты raw `WireGuard server`.
10. Отдельно строит live-срез локальных устройств и raw `WireGuard server` peer'ов по `dnsmasq.leases + conntrack`.

### `scripts/traffic-daily-report`

Локальный CLI-скрипт на рабочей машине.

Что делает:

1. Берёт первый и последний snapshot выбранного дня/периода.
2. Считает закрытые дельты по интерфейсам.
3. Считает per-peer Tailscale дельты между первым и последним JSON snapshot.
4. Считает per-peer raw `WireGuard server` дельты между первым и последним `wg show wgs1 dump`.
5. Показывает end-of-day или end-of-period `LAN DEVICES` и `WIREGUARD SERVER PEERS` снимки из `daily/YYYY-MM-DD-lan-conntrack.txt`.

Примеры:

```bash
./scripts/traffic-report
./scripts/traffic-daily-report today
./scripts/traffic-daily-report yesterday
./scripts/traffic-daily-report 2026-04-14
./scripts/traffic-daily-report week
./scripts/traffic-daily-report month
```

## Как читать метрики

### `WAN total`

Сумма `RX + TX` интерфейса `wan0`.

Это:

- весь внешний трафик между роутером и провайдером
- прямой интернет
- трафик до VPN-серверов
- внешний сервисный трафик роутера
- Tailscale/DERP и прочие внешние соединения

### `VPN total`

Сумма `RX + TX` интерфейса `wgc1`.

Это:

- весь объём, прошедший через `WireGuard`-клиент роутера

### `WG server total`

Сумма `RX + TX` интерфейса `wgs1`.

Это:

- весь объём, который пришёл и ушёл через raw `WireGuard server` роутера
- полезно для ответа на вопрос: “насколько remote raw VPN-клиенты вообще активны”

Это не:

- per-peer breakdown само по себе

### `LAN bridge`

Сумма `RX + TX` интерфейса `br0`.

Это:

- активность всего L2/L3-моста LAN

### `Wi-Fi total`

Сумма `eth6 + eth7` по `RX + TX`.

Это:

- суммарная активность радиоинтерфейсов

### `LAN devices`

Это не байты. Это `conntrack`-снимок.

Колонки:

- `Total` — сколько активных conntrack entries сейчас есть у устройства
- `VPN` — сколько из них сейчас выглядят как вышедшие через `wgc1`
- `WAN` — сколько идут напрямую во внешний канал
- `Local` — сколько локальны для роутера / домашней сети

### `WireGuard server peers`

В отчётах теперь есть два слоя для raw `WireGuard server`.

`WIREGUARD SERVER PEERS (SINCE ...)`:

- per-peer дельты `RX` / `TX` из `wg show wgs1 dump`
- `Latest handshake`
- `Endpoint`

`WIREGUARD SERVER PEERS (CURRENT|END-OF-DAY CONNECTION SNAPSHOT)`:

- conntrack-срез по peer'ам raw `WireGuard server`
- сколько активных соединений у peer'а сейчас или на конец дня ушло через `VPN` / `WAN` / `Local`

### `Tailscale peers`

Это per-peer дельты `RxBytes` / `TxBytes` из `tailscaled`.

Это:

- сколько байт конкретный peer передал и получил по Tailscale

Это не:

- точная разбивка peer'а по `через wgc1` и `мимо wgc1`

## Почему точность разная для `wgs1` и `Tailscale`

### Raw `WireGuard server`

Когда remote клиент подключён напрямую к роутеру по raw `WireGuard server`, после расшифровки трафик входит в обычный сетевой стек с tunnel-адресом peer'а из текущего `wgs1` peer-map.

Упрощённый путь:

```text
iPhone
  -> WireGuard tunnel
  -> wgs1 on router
  -> iptables PREROUTING
  -> RC_VPN_ROUTE
  -> wgc1 or wan0
```

Из-за этого проект может показать:

- router-wide `wgs1` bytes
- per-peer transfer counters из `wg show`
- conntrack-срез peer'ов с tunnel-адресами `wgs1`

Это точнее, чем у `Tailscale Exit Node`.

### `Tailscale Exit Node`

Когда роутер работает как `Tailscale Exit Node`, трафик peer'а сначала приходит в `tailscaled`, а затем userspace-прокси генерирует локальный исходящий трафик на самом роутере.

Упрощённый путь:

```text
iPhone
  -> Tailscale tunnel
  -> tailscaled on router
  -> local socket / router-originated flow
  -> iptables OUTPUT
  -> RC_VPN_ROUTE
  -> wgc1 or wan0
```

Именно поэтому:

- для совпадения с LAN-логикой нужен хук `OUTPUT -> RC_VPN_ROUTE`
- router-wide split-routing работает корректно
- но per-peer identity уже не сохраняется так же прозрачно, как у raw `WireGuard server`

То есть проект умеет одновременно показать:

- `Tailscale peer bytes`
- `router-wide VPN bytes`

Но не умеет без дополнительного сложного трейсинга честно собрать их точное per-peer пересечение.

## Сетевая схема

### Обычный LAN-клиент

```text
LAN device
  -> br0
  -> iptables PREROUTING
  -> RC_VPN_ROUTE
  -> wgc1 or wan0
```

### Raw WireGuard server peer

```text
Remote peer
  -> WireGuard tunnel
  -> wgs1
  -> iptables PREROUTING
  -> RC_VPN_ROUTE
  -> wgc1 or wan0
```

### Tailscale Exit Node peer

```text
Remote peer
  -> Tailscale tunnel
  -> tailscaled
  -> local router-originated flow
  -> iptables OUTPUT
  -> RC_VPN_ROUTE
  -> wgc1 or wan0
```

Эти три схемы и объясняют, почему в `firewall-start` нужны оба hooks:

- `PREROUTING -i br0 -j RC_VPN_ROUTE`
- `PREROUTING -i wgs1 -j RC_VPN_ROUTE`
- `OUTPUT -j RC_VPN_ROUTE`

## Практические ограничения

### Почему у peer'ов бывает `0.00 GiB`

Обычно это одна из двух причин:

- с начала окна peer передал очень мало данных, и после округления в `GiB` получается `0.00`
- baseline snapshot за окно появился недавно, и дельта пока почти нулевая

### Почему история начинается не с полуночи

Отчёты строятся от первого доступного snapshot внутри окна:

- так проще читать
- меньше риск путать старые счётчики интерфейсов с новой конфигурацией

Если история начала собираться уже внутри недели или месяца, это нормально и должно отражаться в `Window start`.

## Что смотреть на практике

- текущий день: `./scripts/traffic-report`
- закрытый день: `./scripts/traffic-daily-report YYYY-MM-DD`
- текущая неделя: `./scripts/traffic-daily-report week`
- текущий месяц: `./scripts/traffic-daily-report month`

Если проблема только у raw `WireGuard server` клиентов:

- смотрите `WG server total`
- смотрите `WIREGUARD SERVER PEERS`
- проверяйте, растут ли conntrack counts у peer'а и в какой колонке (`VPN` / `WAN` / `Local`)

Если проблема только у `Tailscale Exit Node`:

- смотрите `Tailscale total`
- смотрите `TAILSCALE PEERS`
- помните, что per-peer split `VPN` vs `WAN` там принципиально неточный
