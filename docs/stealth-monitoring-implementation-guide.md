# Модуль мониторинга работоспособности GhostRoute

**Назначение:** локальный read-only мониторинг текущей схемы GhostRoute:
router + VPS + Home Reality ingress для remote/mobile devices.

Модуль не меняет маршрутизацию, не чинит сервисы сам, не отправляет внешние
push-уведомления в v1. Он пишет состояние, алерты и отчеты на диск роутера,
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

## Покрытие рисков

`summary-latest.md` содержит Risk Card по таким probe:

| Probe | Что ловит |
|---|---|
| `channel_b_reality` | Reality path через локальный SOCKS перестал работать |
| `vps_path` | router не может открыть TCP/443 к Reality VPS |
| `singbox_health` | sing-box process/listeners unhealthy |
| `home_reality_ingress` | Home Reality ingress `:<home-reality-port>` down/degraded |
| `mobile_activity` | remote/mobile clients давно не видны в логах |
| `mobile_routing_leaks` | heuristic split-routing leak по sing-box logs |
| `rule_set_sync` | dnsmasq STEALTH catalog != sing-box `domain_suffix` rule-set |
| `dns_ipv6_leaks` | IPv6 drift, missing `filter-AAAA`, plain DNS sample |
| `channel_a_resurrection` | retired WireGuard/Channel A вернулся в runtime |
| `catalog_health` | ipset availability/capacity |
| `performance_rtt` | RTT через Reality SOCKS сильно вырос |
| `tcp_retransmits` | TCP retransmit ratio вырос |
| `snapshot_freshness` | traffic/report cron snapshots stale |

Throughput speed-test намеренно не включен в cron v1: мониторинг не должен сам
создавать заметный трафик. Mobile self-check через публичный Caddy receiver
также оставлен на Phase 2.

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
sh -n scripts/health-monitor/lib.sh scripts/health-monitor/run-probes \
  scripts/health-monitor/aggregate scripts/health-monitor/daily-digest \
  scripts/health-monitor/run-once

./tests/test-health-monitor.sh
./tests/test-router-health.sh
./tests/test-catalog-review.sh
./tests/test-dns-forensics.sh
```

Live smoke только после явного разрешения на deploy:

```bash
./verify.sh
ssh admin@<router> '/jffs/scripts/health-monitor/run-once'
ssh admin@<router> 'cat /opt/var/log/router_configuration/health-monitor/summary-latest.md'
```
