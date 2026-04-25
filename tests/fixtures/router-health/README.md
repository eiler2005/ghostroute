# Router Health Fixtures

Этот каталог содержит фикстуры для `tests/test-router-health.sh`.

Их задача не “симулировать весь роутер”, а стабилизировать три текстовых контракта, на которых держится observability-слой.

## Файлы

### `journal-sample.md`

Что это:

- sample-фрагмент локального `docs/vpn-domain-journal.md`
- в нём есть как минимум два capacity snapshot:
  - latest
  - week-old

Что проверяется через него:

- что `router_collect_capacity_history` может:
  - найти нужные snapshot sections
  - вытащить дату
  - вытащить `STEALTH_DOMAINS`
  - вытащить `VPN_STATIC_NETS`
  - вытащить manual/auto rule counts

Почему это важно:

- growth delta в health-report зависит от корректного чтения saved snapshots
- если формат таблицы в journal меняется слишком сильно, health-report теряет историю роста

### `traffic-report-sample.txt`

Что это:

- sample output стабильных summary sections из `traffic-report`

Что проверяется через него:

- что `router_extract_traffic_summary` умеет вытаскивать:
  - `Router-wide window`
  - `Per-device byte window`
  - `WAN total`
  - `Reality-managed total`
  - `Reality share/WAN`
  - `Device byte total`
  - `Via Reality`
  - `Direct WAN`
  - `Other`
  - и что рядом с ними сохраняются стабильные section markers для peer-top summaries

Почему это важно:

- `router-health-report` строит свой traffic summary именно из этих строк
- если заголовки или формат будут “тихо” изменены, downstream report перестанет быть надёжным
- Tailscale peer-top summaries тоже являются частью UX-контракта: LLM и человек ожидают увидеть их в predictable месте

### `state-sample.env`

Что это:

- sample `key=value` state-файл, похожий на результат `router_collect_health_state`

Что проверяется через него:

- что `router_render_health_markdown` действительно собирает итоговый Markdown с ожидаемыми секциями

Почему это важно:

- renderer — последняя точка перед человеком/LLM
- даже если parser'ы работают, сломанный renderer может убрать важную секцию или сделать отчёт нечитаемым

## Как обновлять фикстуры

Обновляйте фикстуры только если вы **осознанно** меняете текстовый контракт.

Хорошее правило:

- если меняется только внутренняя реализация, а формат остаётся тем же — фикстуры не трогаем
- если меняется stable section / table schema / expected field names — сначала осознанно обновляем фикстуры, потом тест

## Чего здесь не должно быть

В фикстурах не должно быть:

- приватных IP из вашей сети
- реальных MAC-адресов
- живых endpoint'ов
- локальных alias'ов из `secrets/`
- реальных ключей / токенов / секретов

Фикстуры должны оставаться полностью безопасными для git.
