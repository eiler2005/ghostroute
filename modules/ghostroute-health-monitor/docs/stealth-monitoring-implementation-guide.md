# Модуль мониторинга работоспособности GhostRoute

**Назначение:** локальный read-only мониторинг текущей схемы GhostRoute:
router + VPS + Home Reality ingress для remote/mobile devices.

Модуль не меняет маршрутизацию, не чинит сервисы сам, не отправляет внешние
push-уведомления в текущем rollout. Он пишет состояние, алерты и отчеты на диск роутера,
чтобы оператор или LLM могли быстро понять, что сломалось и какой runbook
открывать.

## Что устанавливается

Router-side scripts:

```text
/jffs/scripts/health-monitor/
  lib.sh
  run-probes
  aggregate
  daily-digest
  run-once
```

Primary storage:

```text
/opt/var/log/router_configuration/health-monitor
```

Fallback storage:

```text
/jffs/addons/router_configuration/health-monitor
```

Fallback используется только если USB/Entware storage недоступен.

VPS-side scripts устанавливаются Ansible role `vps_health_monitor`:

```text
/opt/stealth/health-monitor/
  lib.sh
  run-probes
  aggregate
  daily-digest
  run-once
  env
```

VPS storage:

```text
/var/log/ghostroute/health-monitor
```

## Файлы состояния

```text
health-monitor/
  STATUS_OK
  STATUS_FAIL
  status.json
  summary-latest.md
  raw/YYYY-MM-DD.jsonl
  alerts/YYYY-MM-DD.jsonl
  alerts/YYYY-MM-DD.md
  daily/YYYY-MM-DD.md
  state/
```

- `STATUS_OK` / `STATUS_FAIL` - быстрый sentinel.
- `status.json` - машинночитаемый текущий статус.
- `summary-latest.md` - главный человекочитаемый отчет.
- `raw/YYYY-MM-DD.jsonl` - все probe events.
- `alerts/YYYY-MM-DD.jsonl` - raw-журнал внутренних алертов.
- `alerts/YYYY-MM-DD.md` - дневная Markdown-сводка алертов.
- `daily/YYYY-MM-DD.md` - дневной digest.

Status values:

```text
OK, WARN, CRIT, SKIP, UNKNOWN
```

`overall` считается так: любой `CRIT` -> `CRIT`; иначе `WARN`/`UNKNOWN` ->
`WARN`; иначе `OK`. `SKIP` сам по себе не ухудшает общий статус.

## Как это работает

1. `run-probes` раз в час читает runtime-состояние роутера и пишет JSONL
   events в `raw/<date>.jsonl`.
2. `aggregate` раз в час, через 2 минуты после `run-probes`, берет последние
   events по каждому probe, строит
   `status.json`, `summary-latest.md` и обновляет `STATUS_OK`/`STATUS_FAIL`.
3. `aggregate` пишет локальный alert, если probe перешел между статусами или
   если `CRIT` повторяется после cooldown.
4. `daily-digest` раз в день обновляет `daily/<date>.md` и применяет retention.

Cron регистрируется через Merlin `cru`, без переписывания
`/opt/etc/crontabs/root`:

```text
HealthMonitorProbes      0 * * * *  /jffs/scripts/health-monitor/run-probes
HealthMonitorAggregate   2 * * * *  /jffs/scripts/health-monitor/aggregate
HealthMonitorDaily       10 3 * * *  /jffs/scripts/health-monitor/daily-digest
```

VPS observer работает отдельно и не ходит на роутер:

```text
GhostRoute VPS probes      1 * * * *   /opt/stealth/health-monitor/run-probes
GhostRoute VPS aggregate   3 * * * *   /opt/stealth/health-monitor/aggregate
GhostRoute VPS daily       15 3 * * *  /opt/stealth/health-monitor/daily-digest
```

## Покрытие рисков

`summary-latest.md` содержит Risk Card по таким probe:

| Probe | Что ловит |
|---|---|
| `channel_a_reality` | Channel A Reality path через локальный SOCKS перестал работать |
| `vps_path` | router не может открыть TCP/443 к Reality VPS |
| `singbox_health` | sing-box process/listeners unhealthy |
| `home_reality_ingress` | Home Reality ingress `:<home-reality-port>` down/degraded |
| `mobile_activity` | remote/mobile clients давно не видны в логах |
| `mobile_routing_leaks` | Channel A / Home Reality `reality-in` connection-ID split-routing leak по sing-box logs |
| `channel_b_routing_leaks` | Channel B `channel-b-relay-socks` connection-ID split-routing leak по sing-box logs |
| `channel_c_routing_leaks` | Channel C `channel-c-naive-in` connection-ID split-routing leak по sing-box logs |
| `rule_set_sync` | dnsmasq STEALTH catalog != sing-box `domain_suffix` rule-set |
| `dns_ipv6_leaks` | IPv6 drift, missing `filter-AAAA`, plain DNS sample |
| `wireguard_resurrection` | retired WireGuard вернулся в runtime |
| `catalog_health` | ipset availability/capacity |
| `performance_rtt` | RTT через Reality SOCKS сильно вырос |
| `tcp_retransmits` | TCP retransmit ratio вырос |
| `snapshot_freshness` | traffic/report cron snapshots stale |

Throughput speed-test намеренно не включен в cron: мониторинг не должен сам
создавать заметный трафик. Mobile self-check через публичный Caddy receiver
остается отдельной последней фазой и по умолчанию выключен.

Phase 2 добавляет rolling baseline для:

- `performance_rtt` - 7 дней samples в `state/baselines/performance_rtt.tsv`;
- `tcp_retransmits` - 7 дней samples в `state/baselines/tcp_retransmits.tsv`.

До 24 samples probe не повышает статус из-за обычных флуктуаций и пишет
`baseline=learning`. После 24 samples используются dynamic thresholds от p95.
Hard guard остается всегда: RTT `>3000ms` или retransmits `>25%` дают `CRIT`.

## VPS observer

VPS observer использует такой же формат `status.json`, `summary-latest.md`,
`alerts/*.jsonl` и `alerts/*.md`, но хранит их на VPS. Он read-only относительно
Caddy/Xray: только читает `ss`, `caddy list-modules`, `docker ps/logs`, `curl`
на localhost и `df`.

Пробки VPS v1:

| Probe | Что ловит |
|---|---|
| `caddy_listener` | Caddy не слушает public TCP/443 |
| `caddy_layer4` | host Caddy потерял layer4 module |
| `xray_reality_listener` | Xray Reality inbound не слушает `127.0.0.1:<xray-local-port>` |
| `xray_container` | Docker container `xray` не запущен |
| `xui_health` | 3x-ui localhost endpoint не отвечает |
| `vps_disk_space` | VPS disk usage высокий/критичный |
| `recent_reality_evidence` | нет recent Reality/inbound evidence в xray logs |

Router не хранит VPS credentials. Единый статус собирается control machine.

## Единый control-machine отчет

`modules/ghostroute-health-monitor/bin/ghostroute-health-report` читает router monitor через существующий
router SSH helper и VPS observer через Ansible inventory/vault:

```bash
./modules/ghostroute-health-monitor/bin/ghostroute-health-report
./modules/ghostroute-health-monitor/bin/ghostroute-health-report --save
```

Без `--save` отчет печатается в stdout. С `--save` он сохраняется на диске
роутера:

```text
health-monitor/global/ghostroute-health-latest.md
health-monitor/global/history/YYYY-MM-DDTHHMMSS+ZZZZ.md
```

History retention: 31 день. В `docs/*latest.md` этот merged report не пишется.

## Mobile self-check hooks

Mobile self-check receiver и iPhone Shortcut остаются последней фазой. В repo
есть только disabled-by-default vault hooks:

```yaml
vault_mobile_checkin_enabled: false
vault_mobile_checkin_public_host: ""
vault_mobile_checkin_token: ""
```

Публичный endpoint не включается, пока operator явно не задаст hostname/token и
не утвердит отдельный rollout.

## Read-only границы

Runtime scripts могут:

- читать `netstat`, `iptables`, `ipset`, `ip`, `nvram`, `/proc/net/snmp`;
- читать sing-box config/logs;
- делать bounded `curl`/`nc`/`tcpdump` samples;
- писать только в `health-monitor/`.

Runtime scripts не должны:

- менять `iptables`, `ipset`, `ip rule`, `nvram`;
- рестартить sing-box, dnsmasq, Caddy, Xray;
- запускать Ansible/deploy;
- удалять историю алертов для "починки" статуса;
- отправлять данные наружу как push-notification.

## Deployment

Есть два пути доставки.

Base deploy:

```bash
ROUTER=192.168.50.1 ./deploy.sh
```

Ansible router role:

```bash
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
```

Оба пути устанавливают `/jffs/scripts/health-monitor/*` и регистрируют cron
через `cru`.

VPS observer устанавливается только VPS playbook:

```bash
cd ansible
ansible-playbook playbooks/10-stealth-vps.yml
```

## Manual commands

На роутере:

```sh
/jffs/scripts/health-monitor/run-once
cat /opt/var/log/router_configuration/health-monitor/summary-latest.md
cat /opt/var/log/router_configuration/health-monitor/status.json
cat /opt/var/log/router_configuration/health-monitor/alerts/$(date +%F).md
```

С локальной машины через SSH:

```bash
ssh admin@<router> '/jffs/scripts/health-monitor/run-once'
ssh admin@<router> 'cat /opt/var/log/router_configuration/health-monitor/summary-latest.md'
ssh admin@<router> 'cat /opt/var/log/router_configuration/health-monitor/alerts/$(date +%F).md'
```

Если primary storage отсутствует, заменить путь на:

```text
/jffs/addons/router_configuration/health-monitor
```

## Alert semantics

Alert event создается, когда:

- probe меняет статус, например `OK -> WARN`, `WARN -> CRIT`, `CRIT -> OK`;
- probe остается в `CRIT`, но прошел cooldown (`3600s` по умолчанию).

Alert остается только локально:

```text
alerts/YYYY-MM-DD.jsonl
alerts/YYYY-MM-DD.md
```

`alerts/*.md` предназначен для человека. `alerts/*.jsonl` - для LLM/скриптов.

## Retention

Retention выполняется `aggregate` и `daily-digest`:

- `raw/*.jsonl` хранится 30 дней;
- `alerts/*.jsonl` и `alerts/*.md` хранятся 90 дней;
- `daily/*.md` хранится 90 дней.

## Compatibility notes

- Shell scripts написаны под BusyBox `/bin/sh`.
- Cron идет через Merlin `cru`.
- `rule_set_sync` использует текущий путь
  `/opt/etc/sing-box/rule-sets/stealth-domains.json`.
- `rule_set_sync` сравнивает `domain_suffix[]`, а не legacy `.domain[]`.
- Никаких Bash-only process substitutions в router-side scripts.

## Tests

Локально:

```bash
sh -n modules/ghostroute-health-monitor/router/lib.sh \
  modules/ghostroute-health-monitor/router/run-probes \
  modules/ghostroute-health-monitor/router/aggregate \
  modules/ghostroute-health-monitor/router/daily-digest \
  modules/ghostroute-health-monitor/router/run-once

./modules/ghostroute-health-monitor/tests/test-health-monitor.sh
./modules/ghostroute-health-monitor/tests/test-vps-health-monitor.sh
./modules/recovery-verification/tests/test-router-health.sh
./modules/dns-catalog-intelligence/tests/test-catalog-review.sh
./modules/dns-catalog-intelligence/tests/test-dns-forensics.sh
./tests/run-all.sh
```

Live smoke только после явного разрешения на deploy:

```bash
./verify.sh
ssh admin@<router> '/jffs/scripts/health-monitor/run-once'
ssh admin@<router> 'cat /opt/var/log/router_configuration/health-monitor/summary-latest.md'
```
