# Catalog Review Fixtures

Этот каталог фиксирует текстовый контракт для `modules/dns-catalog-intelligence/bin/catalog-review-report`.

Задача теста:

- проверить advisory-only review без подключения к живому роутеру
- стабилизировать секции Markdown-отчёта
- убедиться, что report умеет подсвечивать:
  - широкие static CIDR
  - дочерние домены, уже покрытые родительским правилом

## Файлы

### `dnsmasq-sample.conf.add`

Минимальный sample manual domain catalog.

Что проверяется:

- что родитель `example.com` и дочерний `api.example.com` распознаются как cleanup-candidate
- что report считает explicit domain families и строит advisory summary

### `static-networks-sample.txt`

Минимальный sample static coverage.

Что проверяется:

- что report находит широкие CIDR
- что широкие записи выводятся как review-candidates, а не как команды к удалению

### `state-sample.env`

Минимальный sample live-state, похожий на `router_collect_health_state`.

Что проверяется:

- что advisory-report умеет подставлять live `VPN_DOMAINS` / `VPN_STATIC_NETS` counts в summary

## Важно

Это именно recommendational-layer fixtures.

Они не должны содержать:

- приватные IP вашей сети
- реальные endpoint'ы
- device aliases из `secrets/`
- живые секреты или токены
