# CLAUDE.md — Правила работы в этом проекте

## Обязательные ограничения

### Git push
**Никогда не делать `git push` без явного разрешения пользователя.**

Можно делать локально: `git add`, `git commit`. Пушить — только после слов "делай push", "пушь", "push" и т.п.

### Деплой на роутер
**Никогда не запускать `./deploy.sh` и не копировать файлы на роутер (scp/ssh) без явного разрешения пользователя.**

Можно готовить конфиги, редактировать файлы локально. Деплоить — только после явной команды.

---

## Контекст проекта

**Роутер:** ASUS RT-AX88U Pro, Asuswrt-Merlin, BusyBox ash, aarch64  
**VPN:** WireGuard WGC1  
**Pipeline:** dnsmasq → ipset (VPN_DOMAINS / VPN_STATIC_NETS) → iptables fwmark 0x1000 → ip rule → wgc1

### Ключевые файлы

| Файл | Назначение |
|---|---|
| `configs/dnsmasq.conf.add` | Ручные ipset-правила (деплоится на роутер) |
| `configs/dnsmasq-vpn-upstream.conf.add` | DNS upstream через VPN для каждого домена |
| `configs/static-networks.txt` | Статические CIDR-подсети (Telegram, Apple) |
| `configs/domains-no-vpn.txt` | Исключения — домены, не нужные в VPN |
| `scripts/domain-auto-add.sh` | Авто-discovery: cron каждый час на роутере |
| `scripts/domain-report` | Отчёт об авто-добавленных доменах (запуск с Mac) |
| `docs/vpn-domain-journal.md` | Локальный журнал доменов (в .gitignore, не пушить) |

### Workflow добавления домена

1. Добавить `ipset=/<domain>/VPN_DOMAINS` в `configs/dnsmasq.conf.add`
2. Добавить `server=/<domain>/1.1.1.1@wgc1` + `server=/<domain>/9.9.9.9@wgc1` в `configs/dnsmasq-vpn-upstream.conf.add`
3. Получить разрешение → `./deploy.sh`
4. Обновить `docs/vpn-domain-journal.md`
