# Runbook: Модуль мониторинга работоспособности GhostRoute

Этот runbook описывает, как читать локальные алерты на диске роутера и как
восстанавливать работоспособность вручную.

Модуль мониторинга сам ничего не чинит. Все действия, которые меняют runtime
состояние, требуют явного решения оператора.

## 30 секунд: куда смотреть

На роутере primary path:

```text
/opt/var/log/router_configuration/health-monitor
```

Fallback:

```text
/jffs/addons/router_configuration/health-monitor
```

Быстрый порядок чтения:

```sh
cd /opt/var/log/router_configuration/health-monitor
ls STATUS_*
cat summary-latest.md
cat alerts/$(date +%F).md
tail -50 raw/$(date +%F).jsonl
```

Если видишь `STATUS_OK`, общий статус зеленый. Если видишь `STATUS_FAIL`,
сначала читай `summary-latest.md`, затем `alerts/<today>.md`.

## Как работать с алертами на диске роутера

1. Не удаляй `STATUS_FAIL`, `alerts/*.md`, `alerts/*.jsonl` или raw logs.
2. Открой `summary-latest.md` и найди `Non-OK Checks`.
3. Открой `alerts/$(date +%F).md` и посмотри последнюю смену статуса.
4. Если нужен точный факт, найди probe в `raw/$(date +%F).jsonl`.
5. Выполни ручную диагностику по секции ниже.
6. После восстановления запусти `/jffs/scripts/health-monitor/run-once` для
   свежего среза или дождись следующего часового цикла, пока `aggregate`
   вернет `STATUS_OK`.

Пример:

```sh
BASE=/opt/var/log/router_configuration/health-monitor
test -f "$BASE/STATUS_FAIL" && sed -n '1,220p' "$BASE/summary-latest.md"
sed -n '1,220p' "$BASE/alerts/$(date +%F).md"
grep '"probe":"rule_set_sync"' "$BASE/raw/$(date +%F).jsonl" | tail -10
```

## Что можно делать read-only

Можно без отдельного OK:

```sh
cat /opt/var/log/router_configuration/health-monitor/status.json
cat /opt/var/log/router_configuration/health-monitor/summary-latest.md
cat /opt/var/log/router_configuration/health-monitor/alerts/$(date +%F).md
/jffs/scripts/health-monitor/run-once
netstat -nlp
ipset list STEALTH_DOMAINS | head
iptables -S INPUT
iptables -t nat -S PREROUTING
tail -200 /opt/var/log/sing-box.log
```

Нельзя без явного operator OK:

- рестартить `sing-box`, `dnsmasq`, Caddy, Xray;
- менять `iptables`, `ipset`, `ip rule`;
- менять `nvram`;
- запускать `./deploy.sh` или Ansible playbooks;
- включать emergency WireGuard fallback;
- удалять alert/raw историю.

## Recovery by probe

### `channel_b_reality` CRIT

Смысл: router-side SOCKS path `127.0.0.1:<router-socks-port> -> reality-out -> VPS` не вернул
exit IP.

Read-only диагностика:

```sh
netstat -nlp 2>/dev/null | grep -E ':(<router-socks-port>|<lan-redirect-port>|<home-reality-port>) '
tail -100 /opt/var/log/sing-box.log
curl -sm 8 --proxy socks5h://127.0.0.1:<router-socks-port> https://api.ipify.org
```

Вероятные причины:

- sing-box работает, но outbound до VPS сломан;
- Caddy/Xray на VPS недоступны;
- home WAN до VPS деградировал;
- Reality config drift.

Manual recovery требует operator OK: restart sing-box, Ansible verify, VPS
service recovery.

### `vps_path` CRIT

Смысл: роутер не может открыть TCP/443 к Reality VPS.

```sh
grep -A40 '"tag": "reality-out"' /opt/etc/sing-box/config.json
nc -z -w 5 <vps_host> 443
```

Если TCP/443 не открывается, проверь home WAN, VPS firewall, Caddy listener,
provider status. Не меняй routing catalog: это transport problem.

### `singbox_health` CRIT

Смысл: process/listeners missing.

```sh
ps | grep '[s]ing-box'
netstat -nlp 2>/dev/null | grep -E ':(<lan-redirect-port>|<router-socks-port>|<home-reality-port>) '
tail -200 /opt/var/log/sing-box.log
```

Manual recovery: restart `S99singbox` только после просмотра логов и явного OK.

### `home_reality_ingress` CRIT/WARN

Смысл: remote/mobile clients may not enter home router on `:<home-reality-port>`.

```sh
netstat -nlp 2>/dev/null | grep ':<home-reality-port> '
iptables -S INPUT | grep <home-reality-port>
iptables -t mangle -S | grep <home-reality-port>
```

Если listener отсутствует, смотри sing-box inbound config. Если listener есть,
но firewall/MSS drift, смотри `firewall-start` / `stealth-route-init.sh`.
Применение hook меняет runtime и требует OK.

### `mobile_activity` WARN

Смысл: сегодня в sing-box log не было Home Reality клиентов.

Это не всегда поломка: телефоны могли не пользоваться профилем.

Проверить:

```sh
tail -500 /opt/var/log/sing-box.log | grep 'inbound/vless\[reality-in\]'
```

Если устройство должно быть активно, проверить QR/profile в клиентском
приложении, порт `:<home-reality-port>`, домашний публичный host/IP.

### `mobile_routing_leaks` WARN

Смысл: heuristic scan нашел возможный неправильный outbound:

- managed-looking destination ушел через `direct-out`;
- RU/direct-looking destination ушел через `reality-out`.

Проверить:

```sh
/jffs/scripts/health-monitor/run-once
tail -1000 /opt/var/log/sing-box.log | grep -E 'reality-in|reality-out|direct-out'
```

С локальной машины полезно:

```bash
./scripts/traffic-report today
```

Не меняй catalog только по одному heuristic alert. Сначала проверь
`rule_set_sync` и traffic report.

### `rule_set_sync` CRIT

Смысл: dnsmasq STEALTH catalog и sing-box source rule-set разошлись. Это главный
детектор риска "mobile managed domain went direct".

Проверить:

```sh
/jffs/scripts/health-monitor/run-probes --probe rule_set_sync
grep '"probe":"rule_set_sync"' /opt/var/log/router_configuration/health-monitor/raw/$(date +%F).jsonl | tail -5
```

Ожидаемый rule-set:

```text
/opt/etc/sing-box/rule-sets/stealth-domains.json
```

Он должен содержать `domain_suffix`.

Manual recovery с OK:

```sh
/jffs/scripts/update-singbox-rule-sets.sh --restart-if-changed
```

### `dns_ipv6_leaks` WARN/CRIT

Смысл: IPv6/DNS policy drift or plain DNS sample on WAN.

```sh
nvram get ipv6_service
ip -6 addr show dev br0
ip -6 addr show dev wan0
grep '^filter-AAAA$' /jffs/configs/dnsmasq.conf.add
WAN=$(nvram get wan0_ifname)
timeout 30 /opt/bin/tcpdump -nn -i "$WAN" 'udp port 53'
```

Plain DNS or global IPv6 is privacy-sensitive. Do not "fix" by changing
catalog. First identify source and policy drift.

### `channel_a_resurrection` CRIT

Смысл: retired WireGuard/Channel A снова появился в runtime.

```sh
nvram get wgs1_enable
nvram get wgc1_enable
ip link show wgs1
ip link show wgc1
ip rule show | grep -E '0x1000|wgc1'
ipset list VPN_DOMAINS
```

Manual recovery follows Channel A cleanup docs. Emergency fallback is separate
and should be enabled only for catastrophic Reality outage.

### `catalog_health` WARN/CRIT

Смысл: missing ipset or STEALTH catalog capacity risk.

```sh
ipset list STEALTH_DOMAINS | head -30
ipset list VPN_STATIC_NETS | head -30
```

For growth/capacity review:

```bash
./scripts/router-health-report
./scripts/catalog-review-report
```

### `performance_rtt` WARN/CRIT

Смысл: bounded RTT sample through Reality SOCKS is slow.

```sh
curl -sm 8 --proxy socks5h://127.0.0.1:<router-socks-port> -o /dev/null -w '%{time_total}\n' https://api.ipify.org
cat /proc/net/snmp | grep '^Tcp:'
```

Correlate with `tcp_retransmits`, home WAN load, VPS load, user reports.

### `tcp_retransmits` WARN/CRIT

Смысл: TCP retransmit ratio increased.

```sh
cat /proc/net/snmp | grep '^Tcp:'
iptables -t mangle -S | grep TCPMSS
```

Common causes: Wi-Fi loss, ISP path loss, bad MTU/MSS, VPS congestion.

### `snapshot_freshness` WARN/CRIT

Смысл: traffic/report snapshots stale.

```sh
cru l | grep -E 'TrafficSnapshot|TrafficDailyClose|HealthMonitor'
ls -l /opt/var/log/router_configuration/interface-counters.tsv
ls -lt /opt/var/log/router_configuration/daily/ | head
```

If cron is stopped, restarting cron is a runtime action and needs OK.

## Сценарии по симптомам

### 1. Появился `STATUS_FAIL`

- Symptom: sentinel показывает `STATUS_FAIL`, пользовательских жалоб может не быть.
- First files: `summary-latest.md`, затем `alerts/$(date +%F).md`.
- Likely probes: любой non-OK в секции `Non-OK Checks`.
- Read-only diagnostics: `cat status.json`, `grep -A80 'Non-OK Checks' summary-latest.md`.
- Forbidden: удалять sentinel/alerts или перезапускать сервисы ради "очистки" статуса.
- Recovery with OK: выполнять только action из соответствующего probe runbook.
- Confirmation: `/jffs/scripts/health-monitor/run-once`, затем `ls STATUS_*`.

### 2. На iPhone сайты медленные

- Symptom: remote/mobile профиль работает, но страницы открываются медленно.
- First files: `summary-latest.md`, `traffic-report today`, VPS summary если доступен.
- Likely probes: `performance_rtt`, `tcp_retransmits`, `mobile_routing_leaks`, VPS `vps_disk_space`.
- Read-only diagnostics: `tail -1000 /opt/var/log/sing-box.log | grep -E 'reality-in|reality-out'`.
- Forbidden: менять SNI/keypair, catalog или routing без evidence.
- Recovery with OK: перезапуск sing-box/Xray только если probe указывает на service failure.
- Confirmation: `run-once`, затем проверить RTT evidence и пользовательский симптом.

### 3. На iPhone показывает не тот IP

- Symptom: checker показывает домашний IP для managed site или VPS exit IP для direct site.
- First files: `summary-latest.md`, `alerts/<today>.md`, `traffic-report today`.
- Likely probes: `mobile_routing_leaks`, `rule_set_sync`, будущий `mobile_self_check`.
- Read-only diagnostics: проверить `reality-in -> reality-out/direct-out` в sing-box log.
- Forbidden: добавлять домены вслепую только по одному screenshot.
- Recovery with OK: sync rule-set или catalog update после подтверждения домена.
- Confirmation: `rule_set_sync OK`, no `mobile_routing_leaks`, повторный checker.

### 4. Конкретный сайт не открывается

- Symptom: один сайт не работает, остальные направления нормальные.
- First files: `summary-latest.md`, `traffic-report today`, DNS/catatalog docs.
- Likely probes: `rule_set_sync`, `catalog_health`, `dns_ipv6_leaks`.
- Read-only diagnostics: проверить DNS family, ipset hit, наличие домена в dnsmasq и rule-set.
- Forbidden: перезапускать весь stack до проверки, что проблема не в одном домене.
- Recovery with OK: добавить/исключить домен, regenerate rule-sets, затем targeted verify.
- Confirmation: сайт открывается, `rule_set_sync OK`.

### 5. Managed domain ушел direct

- Symptom: managed-сайт видит home WAN вместо VPS.
- First files: `alerts/<today>.md`, raw events по `mobile_routing_leaks` и `rule_set_sync`.
- Likely probes: `rule_set_sync`, `mobile_routing_leaks`, `channel_b_reality`.
- Read-only diagnostics: `grep domain /jffs/configs/dnsmasq.conf.add`, проверить `domain_suffix`.
- Forbidden: менять VPS/Xray, если drift только в catalog/rule-set.
- Recovery with OK: `/jffs/scripts/update-singbox-rule-sets.sh --restart-if-changed`.
- Confirmation: new raw event по `rule_set_sync` со статусом `OK`.

### 6. VPS / Reality down

- Symptom: managed-трафик массово не работает или `channel_b_reality`/`vps_path` CRIT.
- First files: router `summary-latest.md`, VPS `summary-latest.md`, merged report.
- Likely probes: router `channel_b_reality`, `vps_path`; VPS `caddy_listener`, `xray_reality_listener`, `xray_container`.
- Read-only diagnostics: `nc -z -w 5 <vps_host> 443`, `ss -tlnp`, `docker ps`.
- Forbidden: включать emergency fallback без понимания, что VPS или home path сломан.
- Recovery with OK: service recovery на конкретном сломанном слое.
- Confirmation: router `STATUS_OK`, VPS `STATUS_OK`, merged report `Overall OK`.

### 7. `rule_set_sync` CRIT

- Symptom: dnsmasq STEALTH catalog и sing-box `domain_suffix` rule-set разошлись.
- First files: raw events по `rule_set_sync`, `summary-latest.md`.
- Likely probes: `rule_set_sync`, затем `mobile_routing_leaks`.
- Read-only diagnostics: сравнить `/jffs/configs/dnsmasq.conf.add` и `/opt/etc/sing-box/rule-sets/stealth-domains.json`.
- Forbidden: править JSON вручную на роутере.
- Recovery with OK: regenerate rule-set штатным скриптом.
- Confirmation: `run-probes --probe rule_set_sync`, затем `status OK`.

### 8. DNS / IPv6 leak

- Symptom: `dns_ipv6_leaks` WARN/CRIT или подозрение на обход DNS policy.
- First files: `summary-latest.md`, raw evidence по `dns_ipv6_leaks`.
- Likely probes: `dns_ipv6_leaks`, `channel_a_resurrection`.
- Read-only diagnostics: `nvram get ipv6_service`, `ip -6 addr`, bounded tcpdump sample.
- Forbidden: включать IPv6 или менять DNS upstream без отдельного решения.
- Recovery with OK: вернуть Merlin IPv6 disabled, восстановить DNS guard/filter-AAAA.
- Confirmation: `dns_ipv6_leaks OK`, `verify.sh` IPv6 Policy OK.

### 9. Channel A resurrection

- Symptom: старый WireGuard/Channel A появился в runtime.
- First files: `summary-latest.md`, `verify.sh` output.
- Likely probes: `channel_a_resurrection`.
- Read-only diagnostics: `nvram get wgs1_enable`, `ip link show wgs1`, `ip rule show`.
- Forbidden: использовать Channel A как обычный режим.
- Recovery with OK: выполнить decommission cleanup или emergency flow по отдельному runbook.
- Confirmation: `wgs1/wgc1` inactive, `VPN_DOMAINS` absent, `verify.sh OK`.

### 10. Stale snapshots

- Symptom: отчеты есть, но данные старые.
- First files: `summary-latest.md`, `cru l`, traffic report timestamps.
- Likely probes: `snapshot_freshness`.
- Read-only diagnostics: `ls -l /opt/var/log/router_configuration/*counters*`, `cru l`.
- Forbidden: удалять старые snapshots как способ "починки".
- Recovery with OK: восстановить cron/service hook и запустить targeted snapshot.
- Confirmation: `snapshot_freshness OK` после `run-once`.

## После восстановления

Плановый цикл идет раз в час: `run-probes` в `00` минут, `aggregate` в `02`.
Если нужен быстрый post-recovery verdict, не жди следующего часа, а запусти
read-only one-shot.

1. Запусти read-only check:

   ```sh
   /jffs/scripts/health-monitor/run-once
   ```

2. Проверь sentinel:

   ```sh
   ls /opt/var/log/router_configuration/health-monitor/STATUS_*
   ```

3. Прочитай recovery alert в `alerts/<today>.md`. Нормально, если там есть
   переход `CRIT -> OK`.

4. Не удаляй историю алертов. Она нужна для post-incident review.

## Не входит в текущий active rollout

Не входит в текущий active rollout:

- external notifications через ntfy/Telegram/SMS;
- public mobile self-check receiver на Caddy, пока явно не задан hostname/token;
- automatic remediation;
- Prometheus/Grafana.

Эти функции могут читать тот же local alert ledger, но должны проектироваться
отдельно.
