# Быстрый старт

Пошаговая настройка текущей production-схемы GhostRoute.

## 1. Что должно быть готово

### Роутер

- ASUS RT-AX88U Pro или совместимый Asuswrt-Merlin `3006.x`.
- SSH включен: `Administration -> System -> Enable SSH -> LAN only`.
- JFFS custom scripts включены.
- Entware установлен на USB.
- Старый WireGuard client `wgc1` настроен и подключен, если нужны remote `wgs1` клиенты через резервный канал.
- WireGuard VPN Server на роутере (`wgs1`) включен, если используются удаленные iPhone/MacBook через роутер.

### VPS

- VPS/Ubuntu host доступен по SSH.
- Docker Compose установлен.
- Общий Caddy на `:443` используется как system listener with layer4 plugin.
- Xray/3x-ui stack живет отдельно в `/opt/stealth`.

### Control machine

- macOS/Linux.
- `ssh`, `scp`, `nc`.
- Ansible.
- `qrencode` для генерации QR.
- SSH-ключи к роутеру и VPS.
- `~/.vault_pass.txt` для Ansible Vault.

---

## 2. SSH к роутеру

В web UI роутера:

```text
Administration -> System -> Service
Enable SSH: LAN only
Allow SSH password login: Yes during setup, optional later
SSH port: 22
```

Проверка:

```bash
ssh -o PubkeyAcceptedAlgorithms=+ssh-rsa admin@192.168.50.1
```

`deploy.sh` уже использует compatibility options для Merlin/dropbear.

---

## 3. Локальные secrets

Router deploy secrets:

```bash
mkdir -p secrets
cp .env.example secrets/router.env
```

Минимально полезно указать:

```text
ROUTER=192.168.50.1
ROUTER_USER=admin
SSH_IDENTITY_FILE=/Users/<user>/.ssh/id_rsa
```

Stealth secrets:

```bash
./scripts/init-stealth-vault.sh
```

или вручную:

```bash
cd ansible
ansible-vault edit secrets/stealth.yml
```

В документации и чатах допускаются только fake-примеры:

```yaml
router_ssh_host: "192.168.50.1"
reality_server_public_key: "FAKE_PUBLIC_KEY"
clients:
  - name: "iphone-1"
    uuid: "00000000-0000-4000-8000-000000000001"
    short_id: "FAKE_SHORT_ID"
```

---

## 4. Deploy VPS

```bash
cd ansible
ansible-playbook playbooks/00-bootstrap-vps.yml
ansible-playbook playbooks/10-stealth-vps.yml
```

Этот шаг управляет:

- Caddy L4 integration.
- Xray/3x-ui Reality inbound.
- `/opt/stealth` Docker Compose.
- UFW rules.
- 3x-ui clients from vault.

---

## 5. Deploy Router Base Layer

```bash
cd ..
ROUTER=192.168.50.1 ./deploy.sh
```

Этот шаг доставляет и применяет:

- `dnsmasq.conf.add`
- `dnsmasq-stealth.conf.add`
- retired `dnsmasq-vpn-upstream.conf.add` compatibility block
- `static-networks.txt`
- `firewall-start`
- `nat-start`
- cron/reporting scripts
- `domain-auto-add.sh`

---

## 6. Deploy Router Stealth Layer

```bash
cd ansible
ansible-playbook playbooks/20-stealth-router.yml
```

Этот шаг управляет:

- `sing-box`
- sing-box REDIRECT inbound on `0.0.0.0:<lan-redirect-port>`
- `dnscrypt-proxy` on `127.0.0.1:5354`
- `STEALTH_DOMAINS`
- LAN TCP REDIRECT and UDP/443 fallback rules
- `/jffs/scripts/stealth-route-init.sh`

---

## 7. Generate QR Profiles

```bash
ansible-playbook playbooks/30-generate-client-profiles.yml
```

Результат:

```text
ansible/out/clients/iphone-1.png
ansible/out/clients/iphone-1.conf
...
ansible/out/clients/macbook.png
ansible/out/clients/qr-index.html
```

Откройте `ansible/out/clients/qr-index.html` локально и сканируйте QR с нужных устройств.

---

## 8. Verify

```bash
ansible-playbook playbooks/99-verify.yml
cd ..
./verify.sh
./scripts/router-health-report
```

Expected current routing state:

```text
br0 TCP     -> STEALTH_DOMAINS / VPN_STATIC_NETS -> nat REDIRECT :<lan-redirect-port> -> sing-box -> Reality
br0 UDP/443 -> STEALTH_DOMAINS / VPN_STATIC_NETS -> REJECT -> TCP fallback
OUTPUT      -> main routing by default; explicit proxy only for diagnostics
wgs1        -> VPN_DOMAINS / VPN_STATIC_NETS    -> 0x1000 -> table wgc1 -> wgc1
```

Manual router checks:

```sh
netstat -nlp 2>/dev/null | grep ':<lan-redirect-port> '
iptables -t nat -S PREROUTING | grep <lan-redirect-port>
iptables -S FORWARD | grep 'dport 443'
iptables -t mangle -S PREROUTING | grep RC_VPN_ROUTE
ip rule show | grep -E '0x1000|0x2000'
ip route show table wgc1
grep '@wgc1' /jffs/configs/dnsmasq.conf.add
```

`grep '@wgc1'` должен быть пустым для active dnsmasq config.

---

## 9. First Functional Checks

Warm ipsets:

```sh
nslookup youtube.com 127.0.0.1
nslookup ifconfig.me 127.0.0.1
```

Check LAN path:

```sh
ipset list STEALTH_DOMAINS | awk '/^Number of entries:/ {print $4}'
iptables -t nat -vnL PREROUTING | grep 'redir ports <lan-redirect-port>'
tail -100 /opt/var/log/sing-box.log | grep redirect-in
```

Check remote `wgs1` path:

```sh
wg show wgs1 latest-handshakes
ipset list VPN_DOMAINS | awk '/^Number of entries:/ {print $4}'
ip route get <resolved-ip> mark 0x1000
```

---

## 10. What To Read Next

- [architecture.md](architecture.md)
- [channel-routing-operations.md](channel-routing-operations.md)
- [domain-management.md](domain-management.md)
- [troubleshooting.md](troubleshooting.md)
