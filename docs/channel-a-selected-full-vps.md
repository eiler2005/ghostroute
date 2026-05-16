# Channel A Selected Full-VPS

Channel A selected full-VPS is an optional router-side mode for a selected set
of home Wi-Fi/LAN devices or Channel A Home Reality profiles. It keeps the
normal Channel A managed-domain split for everyone else, but sends all
internet-bound traffic from the selected set through the active `reality-out`
egress.

This is not Channel B or Channel C. It does not add a new remote ingress and it
does not change automatic failover behavior.

## Selected Sets

Full-VPS is a selected set policy with two independent selectors:

```text
Home Wi-Fi/LAN set
  selected source IPs -> TPROXY -> channel-a-selected-lan-full-vps-in
  -> reality-out -> active managed egress

Channel A Home Reality set
  selected reality-in auth_user values -> private direct exception
  -> reality-out -> active managed egress
```

The same physical device may be present in both sets. For example, a MacBook can
be selected by its reserved home Wi-Fi IP while at home and by its Home Reality
profile name while remote.

## Vault Configuration Shape

The mode is disabled by default:

```yaml
vault_channel_a_selected_full_vps_enabled: false

vault_channel_a_selected_full_vps_lan_clients:
  - name: "macbook-home"
    mac: "<device_wifi_mac>"
    ip: "<reserved_lan_ip>"
    hostname: "macbook-home"
    interface: "br0"

vault_channel_a_selected_full_vps_home_reality_users:
  - "macbook-home"

vault_channel_a_selected_full_vps_dns_servers:
  - "<strict_dns_resolver_ip>"
```

Real MAC addresses, reserved IPs, resolver IPs and profile names are
deployment-specific values. Keep them in Ansible Vault or a gitignored local
vars file, not in public tracked docs.

## Home Wi-Fi/LAN Behavior

For home Wi-Fi/LAN devices, MAC is used only to make DHCP assign a stable IP.
Runtime routing matches the reserved source IP through
`GR_A_FULL_VPS`. The short runtime name is intentional because ipset set names
on the router are limited to 31 characters.

Selected LAN clients receive a tagged dnsmasq DHCP policy:

```text
dhcp-host=<device_wifi_mac>,set:ghostroute-channel-a-full-vps,<reserved_lan_ip>,<hostname>
dhcp-option=tag:ghostroute-channel-a-full-vps,option:dns-server,<strict_dns_resolver_ip>
```

Their TCP and UDP internet traffic is captured with TPROXY and sent into
`channel-a-selected-lan-full-vps-in`, then to `reality-out`. Local/private
traffic, DHCP and multicast/broadcast traffic stay local. DNS is handled as a
special case: DHCP still advertises the strict resolver, and any plain TCP/UDP
`:53` sent by a selected client to a local/private resolver is TPROXY-captured,
destination-overridden to the strict resolver, and sent through `reality-out`.
This keeps the selected mode working even before a client renews its DNS lease.
Selected source IPs also return early from the normal NAT `PREROUTING` split
rules, so managed REDIRECT and ordinary LAN DNS capture cannot steal their
flows away from the full-VPS TPROXY path.

After enabling or changing a home Wi-Fi/LAN client, renew that device's DHCP
lease or toggle Wi-Fi so it receives the reserved IP and strict DNS option.

## Channel A Home Reality Behavior

For remote Channel A clients, traffic is already inside sing-box on
`reality-in`. Selected profiles are matched by `auth_user` and routed to
`reality-out` before the normal managed/direct split:

```json
{
  "inbound": "reality-in",
  "auth_user": ["macbook-home"],
  "outbound": "reality-out"
}
```

Non-selected Home Reality profiles keep the current behavior:

```text
managed domains/static CIDRs -> reality-out
other destinations           -> direct-out
```

## Verification

Use placeholders only in shared notes and issues. Do not paste real MACs,
reserved IPs, resolver IPs or profile names into tracked docs.

```sh
# Router-side checks, with values from Vault/runtime env substituted locally.
ipset list GR_A_FULL_VPS
iptables -t mangle -S GR_A_FULL_VPS
iptables -t mangle -S GR_A_FULL_VPS | grep -- '--dport 53 .*TPROXY'
iptables -t nat -S PREROUTING | grep 'GR_A_FULL_VPS.*src.*RETURN'
ip rule show | grep '<full_vps_fwmark>'
ip route show table <full_vps_route_table>
netstat -nlp 2>/dev/null | grep ':<full_vps_tproxy_port> '
grep 'channel-a-selected-lan-full-vps-in' /opt/etc/sing-box/config.json
grep '"override_address"' /opt/etc/sing-box/config.json
grep '"auth_user"' /opt/etc/sing-box/config.json
```

Expected behavior:

- selected home Wi-Fi/LAN devices see the active managed egress IP for ordinary
  internet destinations;
- selected Home Reality profiles see the active managed egress IP for ordinary
  internet destinations;
- selected home Wi-Fi/LAN plain DNS either uses the DHCP strict resolver or is
  captured and overridden to that resolver before egressing through
  `reality-out`;
- local/private destinations remain direct;
- non-selected home devices and non-selected Home Reality profiles keep the
  managed-domain split.

## Limits

This mode reuses the current VLESS/Reality egress. YouTube and ordinary app
traffic should follow the VPS exit. Games and other UDP-heavy applications are
best-effort over Reality/XUDP: some games may still show poor latency, jitter or
NAT behavior. If that happens, design a separate UDP-native gaming lane instead
of broadening WireGuard cold fallback or Channel B/C ownership. Channel B does
not provide full-VPS selection in this design.

IPv6 remains disabled or filtered unless a separate IPv6 routing design is
added for this mode.
