# Future Improvements Backlog

Этот документ фиксирует **отложенные улучшения** для `ghostroute` / `router_configuration`.

Главная идея: текущая конфигурация считается рабочей и стабильной, поэтому этот backlog нужен не для немедленного внедрения, а как **готовый контекст для будущей LLM-сессии или аккуратной рефакторинговой работы**.

## Текущий статус

На момент актуализации backlog система работает в двухканальной схеме:

- `STEALTH_DOMAINS` и `VPN_STATIC_NETS` обслуживают LAN traffic:
  - `br0` — обычные LAN / Wi-Fi клиенты
  - TCP egress: nat `REDIRECT :<lan-redirect-port>` → sing-box → VLESS+Reality
  - UDP/443: REJECT для managed destinations, чтобы клиенты fallback'ились с QUIC на TCP
  - router `OUTPUT` по умолчанию не перехватывается, чтобы не создать loop для sing-box outbound
- `VPN_DOMAINS` и `VPN_STATIC_NETS` обслуживают remote `WireGuard server` clients:
  - `wgs1` — raw remote clients
  - egress: `0x1000` → table `wgc1`
- `wgc1` больше не основной LAN uplink; это reserve/legacy канал для remote `wgs1` clients
- для `wgs1` есть DNS-capture в локальный `dnsmasq`
- DNS upstream централизован через `dnscrypt-proxy` на `127.0.0.1:5354`
- traffic observability и device mix reporting работают с этой новой routing matrix

Дополнительно уже реализован безопасный observability-слой вокруг runtime-конфигурации:

- `./verify.sh` теперь по умолчанию даёт compact health-summary
- `./verify.sh --verbose` оставлен для deep diagnostics
- `./scripts/router-health-report` даёт sanitised Markdown snapshot для человека и LLM
- `./scripts/router-health-report --save` обновляет:
  - tracked `docs/router-health-latest.md`
  - local `docs/vpn-domain-journal.md`
  - router-side USB-backed reports в `/opt/var/log/router_configuration/reports/`
- traffic-отчёты приведены к более стабильной форме секций
- fixture/smoke тесты для health-reporting уже добавлены
- growth trends и интерпретация роста уже встроены в health/capacity слой
- peer-level short summaries для `WireGuard server` и `Tailscale` уже встроены в traffic-отчёты

## Важное ограничение

По умолчанию этот backlog **не означает “срочно внедрить всё”**.

Базовое правило для будущей работы:

- если runtime стабилен, не менять живую конфигурацию без явной причины
- любые изменения сначала делать как review / plan / safe refactor
- не трогать `secrets/` и не выносить приватные aliases / IP / bypass overrides в публичный git

## Как использовать этот документ с LLM

Если позже захотите отдать это другому агенту или LLM, можно использовать такой prompt:

```text
Изучи docs/future-improvements-backlog.md, README.md, README-ru.md и ключевые документы из docs/.
Ничего не меняй сразу.
Сначала оцени текущее состояние репозитория и live-конфигурации роутера, затем предложи безопасный пошаговый план реализации backlog-пункта <НУЖНЫЙ_ПУНКТ>.
Если runtime уже стабилен, приоритет — минимальный риск, обратимость и observability.
Не выноси локальные secrets в git и не меняй живую конфигурацию без явного подтверждения.
```

Если нужен полный backlog-review:

```text
Изучи docs/future-improvements-backlog.md как основной backlog-документ.
Сделай review: что из этого всё ещё актуально, что потеряло смысл, что стоит делать первым.
Нужен только план, без implementation по умолчанию.
```

## Приоритетные направления

### 1. Ужесточить auto-discovery доменов

Проблема:

- auto-discovery сейчас может быть слишком шумным
- в candidate/log pipeline уже встречались широкие или malformed записи
- есть риск over-routing через слишком общие семейства

Что улучшить:

- ввести более жёсткую нормализацию кандидатов до записи в auto-file
- отсекать публичные суффиксы и слишком широкие семейства
- повысить порог admission для слабых сигналов
- разделить allow/deny feedback для спорных auto-case'ов

Желаемый результат:

- auto-каталог остаётся полезным, но становится заметно более чистым и предсказуемым

### 2. Ревизия manual/static coverage

Проблема:

- в конфигурации есть широкие CIDR и крупные доменные семейства
- часть покрытия могла появиться как pragmatic workaround и со временем стать избыточной

Что улучшить:

- пройтись по широким static CIDR и оценить, какие из них реально всё ещё нужны
- отделить truly-required coverage от исторически накопленного
- оставить большие сети только там, где DNS-based coverage недостаточен

Статус:

- recommendational layer уже реализован:
  - `./scripts/catalog-review-report`
  - `./scripts/catalog-review-report --save`
  - tracked `docs/catalog-review-latest.md`
  - USB-backed advisory snapshots на роутере
- текущая реализация ничего не меняет в runtime и не делает cleanup автоматически
- в backlog остаётся следующий шаг:
  - живой review widest CIDR и explicit child domains
  - осторожный cleanup только после smoke-подтверждения, что coverage не потеряется

Желаемый результат:

- routing catalog становится уже и понятнее, без потери нужного покрытия

### 3. Компактный health-summary и drift detection

Проблема:

- текущий `verify.sh` слишком шумный
- live-state роутера и repo-managed state трудно сравнивать быстро

Что улучшить:

- сделать компактный health-summary по умолчанию
- verbose-режим оставить только для deep diagnostics
- добавить явную проверку drift между live-router state и repo-managed ожиданием

Статус:

- основная часть уже реализована:
  - `verify.sh` печатает compact summary по умолчанию
  - `verify.sh --verbose` оставлен для deep diagnostics
  - drift показывается как human-readable mismatch list, а не как full dump
  - `Growth Trends` уже встроен в default summary
  - exit codes уже разделены на `OK / Warning / Critical`
  - tracked `router-health-latest.md` и local journal дают стабильную точку сравнения
- в backlog остаётся только эволюционно улучшать сами проверки, тексты предупреждений и пороги, если появится реальная operational-боль

Желаемый результат:

- типовая проверка после deploy или при проблеме занимает минуты, а не ручной разбор большого вывода

### 4. Улучшить observability и форму отчётов

Проблема:

- router-wide totals и per-device byte window могут быть из разных временных окон
- это уже объясняется в отчётах, но всё ещё может путать

Что улучшить:

- продолжить улучшение day/week/month summaries
- лучше показывать `Top by VPN`, `Top by direct WAN`, `Top by WG server peers`
- сохранить разделение на public-safe output и local-only aliases

Статус:

- значимая часть уже реализована:
  - стабильные секции `Window / Totals / Device Traffic Mix / Top by VPN / Top by Direct WAN / Top by WG server peers / Top by Tailscale peers / Notes`
  - tracked sanitised `router-health-latest.md`
  - явный LLM-runbook
  - USB-backed health snapshots на роутере
  - fixture/smoke тесты фиксируют текстовый контракт observability-слоя
- в backlog остаются только дальнейшие улучшения формы, интерпретации и, при желании, более компактные executive-style summaries

Желаемый результат:

- отчёты читаются как готовый operational summary, без повторных пояснений

### 5. Явная политика по IPv6

Проблема:

- IPv6 поддержка в routing-layer пока не оформлена как полноценная и завершённая история

Что улучшить:

- явно зафиксировать текущую supported policy
- описать, что считается поддерживаемым сценарием, а что нет
- если когда-нибудь делать IPv6 routing, то отдельным проектом с отдельной верификацией

Желаемый результат:

- нет ложных ожиданий и случайных regressions из-за полу-поддержанного dual-stack поведения

### 6. Fallback-источники и retention/rotation

Проблема:

- часть operational цепочки зависит от внешних источников и накопления логов

Что улучшить:

- продумать резервный источник для blocked-list
- уточнить retention/rotation policy для логов и snapshots
- развести тяжёлые cron-задачи во времени, если это потребуется

Желаемый результат:

- система лучше переносит внешние сбои и меньше зависит от удачного стечения operational условий

### 7. Мониторинг ёмкости каталога и growth trends

Проблема:

- сейчас `VPN_DOMAINS` и `VPN_STATIC_NETS` далеки от лимитов, но рост каталога уже стал отдельной operational темой
- знание “места пока хватает” полезно, но без регулярного мониторинга легко пропустить ускорение роста, шумный auto-discovery или неожиданное разрастание static coverage

Что улучшить:

- ввести явный monitoring для:
  - числа IP в `VPN_DOMAINS`
  - числа CIDR в `VPN_STATIC_NETS`
  - использования лимита `maxelem`
  - headroom до лимита
  - скорости роста по дням и неделям
- печатать эти метрики в компактном health-summary, а не только в разовых manual snapshots
- зафиксировать пороги предупреждений, например:
  - informational — заметный рост без риска
  - warning — устойчивый рост или выход за условный safe threshold
  - critical — приближение к лимиту или аномальный скачок за короткое окно
- отдельно мониторить размер auto-discovered catalog, чтобы видеть, не он ли стал источником разрастания

Статус:

- базовый monitoring уже реализован:
  - `VPN_DOMAINS current`
  - `VPN_DOMAINS maxelem`
  - usage/headroom
  - `VPN_STATIC_NETS current`
  - manual / auto rule counts
  - delta к последнему сохранённому local snapshot
  - `Growth Trends` в `verify.sh`
  - `Growth level` / `Growth note` в `router-health-report`
  - сохранение capacity/growth snapshot в local journal через `router-health-report --save`
- backlog здесь сохраняется для следующего шага:
  - более длинные historical trends beyond local journal cadence
  - более богатая week-over-week/month-over-month аналитика, если история накопится и это реально понадобится
  - ещё более умные growth thresholds, если появится реальная operational-боль
  - возможно отдельный compact capacity-only summary

Желаемый результат:

- даже при текущем комфортном уровне заполнения можно быстро видеть тренд, headroom и момент, когда каталог действительно начинает требовать cleanup или пересмотра правил

### 8. Свести публичный `wgs1` к backup и позже убрать WAN ingress

Проблема:

- сейчас raw `WireGuard server` на `wgs1` остаётся публичным WAN ingress
- это повышает внешнюю поверхность даже при рабочем routing-layer и хорошем health/observability
- для регулярного remote access удобнее иметь отдельный overlay / zero-trust access path, а не зависеть от публичного `wgs1`

Что улучшить:

- рассмотреть migration path на альтернативный remote-access слой:
  - `ZeroTier`
  - `NetBird`
  - `OpenZiti`
- сначала держать новую схему параллельно с `wgs1`
- затем перевести существующих `wgs1` клиентов на новую схему
- после успешной миграции выключить публичный `wgs1` на WAN или оставить только как строго временный аварийный backup

Статус:

- planning-only analysis уже зафиксирован в отдельном документе:
  - [remote-access-overlay-migration.md](remote-access-overlay-migration.md)
- там сохранены:
  - live observations по текущему `wgs1` surface
  - shortlist кандидатов
  - iPhone onboarding notes
  - migration plans для `ZeroTier`, `NetBird`, `OpenZiti`
- backlog здесь **не означает обязательное внедрение**
- это отдельное future direction, к которому имеет смысл возвращаться только если действительно есть цель убрать публичный `wgs1` из роли основного ingress

Желаемый результат:

- основной remote access больше не зависит от публичного `wgs1`
- старые `wgs1` клиенты аккуратно мигрированы
- внешний surface роутера становится меньше без слома текущего routing catalog

## Что не делать по умолчанию

Без отдельного решения не стоит:

- массово переписывать manual catalog
- пересобирать runtime rules “на всякий случай”
- менять live-router config только потому, что backlog выглядит логично на бумаге
- раскрывать реальные device aliases, private IP и локальные bypass overrides в публичных документах

## Минимальный safe workflow на будущее

Если позже начнётся реализация любого backlog-пункта, безопасный порядок такой:

1. перечитать этот backlog и смежные docs
2. снять live-state роутера и убедиться, что проблема действительно существует
3. сначала сделать plan, потом минимальный change-set
4. обязательно сохранить observability и rollback path
5. только после этого вносить runtime-изменения

## Связанные документы

- [architecture.md](architecture.md)
- [domain-management.md](domain-management.md)
- [traffic-observability.md](traffic-observability.md)
- [llm-traffic-runbook.md](llm-traffic-runbook.md)
- [remote-access-overlay-migration.md](remote-access-overlay-migration.md)
- [x3mrouting-roadmap.md](x3mrouting-roadmap.md)
