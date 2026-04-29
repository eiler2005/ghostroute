# Future Improvements Backlog

Этот документ фиксирует **отложенные улучшения** для `ghostroute` / `router_configuration`.

Главная идея: текущая конфигурация считается рабочей и стабильной, поэтому этот backlog нужен не для немедленного внедрения, а как **готовый контекст для будущей LLM-сессии или аккуратной рефакторинговой работы**.

## Текущий статус

На момент актуализации backlog система работает в Reality-only схеме:

- `STEALTH_DOMAINS` и `VPN_STATIC_NETS` обслуживают LAN traffic:
  - `br0` — обычные LAN / Wi-Fi клиенты
  - TCP egress: nat `REDIRECT :<lan-redirect-port>` → sing-box → VLESS+Reality
  - UDP/443: DROP для managed destinations, чтобы клиенты fallback'ились с QUIC на TCP
  - router `OUTPUT` по умолчанию не перехватывается, чтобы не создать loop для sing-box outbound
- mobile QR clients (`iphone-*`, `macbook`) обслуживаются через home Reality ingress:
  - first hop: client → домашний белый IP `:<home-reality-port>`
  - router ingress: `sing-box` home Reality inbound
  - egress: managed split policy; `STEALTH_DOMAINS` / `VPN_STATIC_NETS` → VPS/Xray, остальные назначения → home WAN direct
- Legacy WireGuard (`wgs1` + `wgc1`) runtime выключен; `wgc1_*` NVRAM сохранён только как cold fallback
- `VPN_DOMAINS` отсутствует в steady state; active domain catalog is `STEALTH_DOMAINS`
- DNS upstream централизован через `dnscrypt-proxy` на `127.0.0.1:<dnscrypt-port>`
- traffic observability и device mix reporting работают с этой новой routing matrix
- Channel B является production для selected device-client profiles:
  `VLESS+XHTTP+TLS` home-first ingress на роутере, затем local relay в sing-box
  managed split без изменений router REDIRECT/DNS/TUN ownership.
- Channel C имеет live-proven C1-Shadowrocket HTTPS CONNECT compatibility на
  роутере и C1-sing-box native Naive design, который server-ready, но
  client-blocked на tested iPhone SFI `1.11.4`.

Дополнительно уже реализован безопасный observability-слой вокруг runtime-конфигурации:

- `./verify.sh` теперь по умолчанию даёт compact health-summary
- `./verify.sh --verbose` оставлен для deep diagnostics
- `./modules/ghostroute-health-monitor/bin/router-health-report` даёт sanitised Markdown snapshot для человека и LLM
- `./modules/ghostroute-health-monitor/bin/router-health-report --save` обновляет:
  - local `reports/router-health-latest.md`
  - local `docs/vpn-domain-journal.md`
  - router-side USB-backed reports в `/opt/var/log/router_configuration/reports/`
- traffic-отчёты приведены к более стабильной форме секций
- mobile Home Reality получил байтовый учёт encrypted TCP/<home-reality-port> ingress через `RC_MOBILE_REALITY_IN/OUT`
- fixture/smoke тесты для health-reporting уже добавлены
- growth trends и интерпретация роста уже встроены в health/capacity слой
- peer-level short summaries для `Tailscale` уже встроены в traffic-отчёты

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
  - `./modules/dns-catalog-intelligence/bin/catalog-review-report`
  - `./modules/dns-catalog-intelligence/bin/catalog-review-report --save`
  - local `reports/catalog-review-latest.md`
  - USB-backed advisory snapshots на роутере
- текущая реализация ничего не меняет в runtime и не делает cleanup автоматически
- в backlog остаётся следующий шаг:
  - живой review widest CIDR и explicit child domains
  - осторожный cleanup только после smoke-подтверждения, что coverage не потеряется

Желаемый результат:

- routing catalog становится уже и понятнее, без потери нужного покрытия

### 2.1. STEALTH_DOMAINS curation scoring

Проблема:

- manual `STEALTH_DOMAINS` catalog может со временем разрастаться и вести через Reality домены, которым достаточно direct WAN
- простое auto-removal небезопасно: “нужно / не нужно” зависит от user intent, аккаунтов, поездок, app quirks и geo/account consistency

Что улучшить:

- добавить advisory-only scoring поверх уже существующих данных:
  - DNS forensics
  - traffic reports
  - `blocked-domains.lst`
  - ISP probe из `domain-auto-add.sh`
  - manual labels вроде `keep-managed`, `candidate-direct`, `temporary`
- выдавать рекомендации `keep`, `needs-live-evidence`, `move-to-no-vpn`, `remove-later`
- не удалять записи автоматически и не переписывать `domains-no-vpn.txt` без ручного решения

Статус:

- стартовый audit создан в [modules/dns-catalog-intelligence/docs/stealth-domains-curation-audit.md](/modules/dns-catalog-intelligence/docs/stealth-domains-curation-audit.md)
- runtime catalog не менялся
- future implementation должна быть report-only до отдельного решения

Желаемый результат:

- можно безопасно сужать managed catalog по evidence, снижая CPU/egress нагрузку без внезапных regressions

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
  - local `router-health-latest.md` и local journal дают стабильную точку сравнения
- в backlog остаётся только эволюционно улучшать сами проверки, тексты предупреждений и пороги, если появится реальная operational-боль

Желаемый результат:

- типовая проверка после deploy или при проблеме занимает минуты, а не ручной разбор большого вывода

### 4. Улучшить observability и форму отчётов

Проблема:

- router-wide totals и per-device byte window могут быть из разных временных окон
- это уже объясняется в отчётах, но всё ещё может путать

Что улучшить:

- продолжить улучшение day/week/month summaries
- лучше показывать `Top by Reality`, `Top by direct WAN`, `Top by Tailscale peers`
- сохранить разделение на public-safe output и local-only aliases
- привести router-side log naming к channel-aware схеме, не ломая текущие
  отчёты и runbooks:
  - текущий `/opt/var/log/sing-box.log` считать shared sing-box data-plane log,
    а не Channel A log, потому что он содержит A/Home Reality, B relay, C1 и
    `reality-out` / `direct-out` split evidence
  - текущий `/opt/var/log/xray-channel-b-home.log` считать Channel B ingress
    attribution log
  - future target для новых путей: `/opt/var/log/router_configuration/channels/`
    с именами вроде `shared-singbox-data-plane.log` и
    `channel-b-ingress-xray.log`
  - `traffic-report`, health/runbooks и rotation должны сначала читать новый
    путь, затем fallback на старые файлы, пока миграция не будет доказана live

Статус:

- значимая часть уже реализована:
  - стабильные секции `Window / Totals / Device Traffic Mix / Top by Reality / Top by Direct WAN / Top by Tailscale peers / LAN Device Bytes / Notes`
  - per-device `Via Reality` восстановлен после ухода от `wgc1` через `RC_LAN_REALITY_OUT/IN` mangle counters
  - `traffic-daily-report` теперь строит day/week/month deltas из snapshot TSV:
    `interface-counters.tsv`, `lan-device-counters.tsv`,
    `mobile-reality-counters.tsv`
  - mobile Home Reality activity is integrated into `traffic-report` and
    `router-health-report` with:
    - encrypted TCP/<home-reality-port> byte totals from `RC_MOBILE_REALITY_IN/OUT`
    - log-attributed connection counts by profile, outbound
      (`reality-out`/`direct-out`) and destination
    - explicit caveat for shared carrier NAT IPs: byte rows can be combined by source label
  - local sanitised `router-health-latest.md`
  - явный LLM-runbook
  - USB-backed health snapshots на роутере
  - fixture/smoke тесты фиксируют текстовый контракт observability-слоя
- в backlog остаются только дальнейшие улучшения формы, интерпретации и, при желании, более компактные executive-style summaries; per-profile byte split by final outbound would require sing-box metrics/exporter support and is not implemented in the current log-only model
- log naming cleanup остаётся future-only: это router-side Ansible/runtime
  change, требующий deploy на роутер, restart затронутых services, smoke-check
  `traffic-report today`, `traffic-report check`, rotation и явный rollback.

Желаемый результат:

- отчёты читаются как готовый operational summary, без повторных пояснений
- имена log sources отражают фактическую роль: shared data-plane, Channel B
  ingress attribution, Channel C ingress evidence, а не исторические имена
  конкретных демонов

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

- сейчас `STEALTH_DOMAINS` и `VPN_STATIC_NETS` далеки от лимитов, но рост каталога уже стал отдельной operational темой
- знание “места пока хватает” полезно, но без регулярного мониторинга легко пропустить ускорение роста, шумный auto-discovery или неожиданное разрастание static coverage

Что улучшить:

- ввести явный monitoring для:
  - числа IP в `STEALTH_DOMAINS`
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
  - `STEALTH_DOMAINS current`
  - `STEALTH_DOMAINS maxelem`
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

Статус:

- выполнено в рамках WireGuard final cleanup: `wgs1_enable=0`, `wgc1_enable=0`, `wg show` пустой, публичный WireGuard ingress не является active path
- `VPN_DOMAINS`, `0x1000`, `RC_VPN_ROUTE` и stale `wgs1/wgc1` hooks удалены из steady state
- `wgc1_*` NVRAM сохранён только для cold fallback через `modules/recovery-verification/router/emergency-enable-wgc1.sh`
- регулярный mobile egress уже переведен на home Reality QR (`client -> ASUS :<home-reality-port> -> VPS`)

Что остаётся future-only:

- рассмотреть migration path на альтернативный remote-access слой:
  - `ZeroTier`
  - `NetBird`
  - `OpenZiti`
- если нужен именно доступ к домашней LAN, рассмотреть отдельный overlay / zero-trust access path
- planning-only analysis по overlay уже зафиксирован в отдельном документе:
  - [remote-access-overlay-migration.md](remote-access-overlay-migration.md)
- там сохранены:
  - historical observations по прежнему `wgs1` surface
  - shortlist кандидатов
  - iPhone onboarding notes
  - migration plans для `ZeroTier`, `NetBird`, `OpenZiti`
- backlog здесь **не означает обязательное внедрение**
- это отдельное future direction, к которому имеет смысл возвращаться только если нужен remote LAN access beyond mobile Reality egress

Желаемый результат:

- основной remote access больше не зависит от публичного `wgs1`
- старые `wgs1` клиенты мигрированы на Reality QR или будущий overlay по назначению
- внешний surface роутера становится меньше без слома текущего routing catalog

### 9. Довести Channel C и поддерживать Channel B/C device-client lanes

Текущий статус:

- Channel A остаётся единственным production data plane:
  `router sing-box REDIRECT -> VLESS+Reality+Vision -> VPS`.
- Channel B считается production для selected device-client profiles:
  home-first XHTTP/TLS ingress на роутере -> local sing-box relay -> тот же
  managed split и Reality/Vision upstream.
- Channel C C1-Shadowrocket compatibility прошел live proof и persisted в
  Ansible/firewall/profile generation/verify.
- Channel C C1-sing-box native Naive server-side lane существует на роутере,
  но tested iPhone SFI `1.11.4` rejected outbound `type: naive`; native SFI
  profile generation disabled by default до совместимого iOS клиента.
- B/C не дают automatic failover и не должны менять Channel A
  REDIRECT/DNS/TUN ownership.

Channel B maintenance target:

- `Device client -> home XHTTP/TLS ingress -> router local Xray -> sing-box managed split -> Internet`
- не менять router REDIRECT/DNS/TUN
- не добавлять automatic failover
- поддерживать live evidence для selected devices: import работает, managed
  egress подтвержден внешними checks и логами, non-managed egress остается home
  WAN

Channel C target:

- Native C1: `Device client -> home Naive/HTTPS-H2-CONNECT-like ingress ->
  router sing-box channel-c-naive-in -> managed split -> Reality/Vision -> VPS
  -> Internet`
- C1-Shadowrocket: `Shadowrocket -> home HTTPS CONNECT/TLS ingress -> router sing-box
  channel-c-shadowrocket-http-in -> managed split -> Reality/Vision -> VPS ->
  Internet`
- оставить native Naive stealth-primary для SFI/sing-box
- закрепить C1-Shadowrocket как explicit compatibility lane, не называя его Naive
- готовность: Ansible persistence, firewall idempotence, generated profiles,
  verify checks and live app traffic доказаны для каждого выбранного клиента

Желаемый результат:

- Channel B остается стабильным selected-client production lane без риска для
  Channel A и домашнего роутера
- Channel C можно безопасно довести от live proof до persisted deployment
- документация явно отделяет Channel A router data plane, Channel B
  selected-client production и Channel C native/compatibility split

Future Caddy forward_proxy@naive / forwardproxy experiment:

- Рассмотреть только как отдельную future research lane, не как замену текущему
  рабочему C1-Shadowrocket.
- Цель эксперимента: проверить, даст ли `Shadowrocket -> Caddy
  forward_proxy/forwardproxy@naive -> managed split` более похожий на
  HTTPS/H2/NaiveProxy traffic профиль, чем текущий sing-box HTTP inbound
  compatibility path.
- Не подвешивать эксперимент на существующий VPS Caddy `:443` без отдельного
  design review: VPS Caddy уже держит shared Reality edge и optional Channel B
  direct-XHTTP route, поэтому ошибка в Caddyfile может затронуть Channel A/B.
- Предпочтительная форма для исследования: isolated home/router-side или
  отдельный hostname/port, отдельные credentials, отдельный playbook/flag,
  отдельные verify checks и явный rollback.
- Риски, которые нужно закрыть до implementation:
  - не открыть public unauthenticated forward proxy;
  - не сломать VPS Caddy/Reality edge;
  - не перепутать C1-SR compatibility с native Naive proof;
  - проверить, что Shadowrocket реально использует ожидаемый HTTP/2/CONNECT
    режим, а не просто импортирует профиль;
  - состыковать egress с router managed split без изменения Channel A
    REDIRECT/DNS/TUN ownership.
  - учесть, что Chrome-like masking зависит не только от Caddy backend, но и от
    client fingerprint; Shadowrocket + forward_proxy не равен official
    NaiveProxy client с Chromium network stack.

### 10. Policy-Based DNS / Own Resolver Strategy

Текущий вывод:

- Сейчас менять runtime DNS не нужно, если нет фактического DNS leak к
  мобильному оператору.
- BrowserLeaks с `Public IP: RF/home` и `DNS: Google/Cloudflare/Finland` — это
  mixed fingerprint/noise, но не доказательство LTE DNS leak.
- Основной current goal: мобильный оператор не должен видеть DNS-interest и
  финальные managed destinations. Resolver country/ASN consistency — вторичная
  косметика fingerprint.

Future direction:

```text
local/private/RF/trusted domains
  -> home router / ISP-like RF resolver

managed foreign domains
  -> encrypted/tunneled resolver path or VPS Unbound

Channel B VPS-like profile
  -> VPS Unbound / VPS-side DNS endpoint

Channel A RF-like profile
  -> home/router resolver only if RF consistency becomes more important than
     DNS privacy from the home ISP/resolver
```

Возможный выигрыш:

- BrowserLeaks показывает меньше resolver noise вместо 100+ Google/Cloudflare
  anycast servers.
- DNS fingerprint становится управляемее: можно согласовать resolver ASN/country
  с выбранным channel profile.
- Для Channel B/VPS-like профиля свой VPS resolver может выглядеть чище:
  `Public IP: VPS` и `DNS: VPS`.
- Уменьшается зависимость от публичных Google/Cloudflare/Quad9 fingerprints.

Риски и trade-offs:

- DNS/IP geo mismatch может стать хуже для RF-profile:
  `Public IP: home RF`, но `DNS resolver: VPS Finland`.
- CDN может отдавать менее оптимальные edge IP, особенно для российских сайтов.
- Банки, стриминг, гос/операторские и antifraud-heavy сервисы могут сильнее
  реагировать на resolver/client geography mismatch.
- Local/provider-only names и некоторые РФ CDN optimizations могут работать хуже
  через зарубежный recursive resolver.
- Если Unbound на VPS случайно открыть наружу, получится public open resolver и
  DNS amplification/abuse risk.
- Новый DNS endpoint становится отдельной точкой отказа: `DNS down` выглядит
  для пользователя как `internet down`.
- DoH внутри приложений всё равно может обойти router DNS policy, если не
  закрывать это отдельно на client/profile level.

Оценка сложности:

- MVP report/proof only: 1-2 дня.
- VPS Unbound для Channel B only: 2-3 дня с firewall и verify.
- Полноценный policy-based DNS по channel/domain classes: 3-7 дней, потому что
  нужно синхронизировать DNS decision с routing decision, observability и
  rollback.

Рекомендуемые фазы:

1. `Phase 0` — оставить текущую privacy-first DNS модель, использовать
   [dns-policy.md](dns-policy.md) как proof checklist.
2. `Phase 1` — read-only DNS proof/report: BrowserLeaks interpretation,
   resolver ASN/country, no LTE carrier, IPv6 absent/routed.
3. `Phase 2` — VPS Unbound только для Channel B/VPS-like профиля, строго
   localhost/private access only, public `53/tcp,udp` закрыт firewall'ом.
4. `Phase 3` — optional Channel A RF-consistent DNS mode только если будет
   явная потребность в RF-looking BrowserLeaks.
5. `Phase 4` — аккуратный policy split:
   `local/private/RF/trusted -> home/RF resolver`, `managed/foreign -> tunneled
   resolver/VPS Unbound`.

Что не делать по умолчанию:

- Не переключать все каналы на VPS Unbound.
- Не заменять privacy-first DNS на RF resolver только ради красивого
  BrowserLeaks screenshot.
- Не открывать DNS endpoint наружу.
- Не менять DNS runtime без rollback и external proof.

### 11. Semi-auto backup VPS egress для managed domains

Отдельный future-roadmap зафиксирован в
[managed-egress-failover-roadmap.md](managed-egress-failover-roadmap.md).

Идея: если primary Hetzner/VPS как foreign managed egress недоступен, роутер
может полуавтоматически переключить только managed destinations на резервный
`VLESS + Reality/Vision` VPS у другого провайдера/ASN. Router-managed split
остается владельцем policy: `STEALTH_DOMAINS` / `VPN_STATIC_NETS` по-прежнему
решают, что идет через foreign egress, а direct/RU/default трафик остается на
home WAN.

Ключевые ограничения:

- switch должен быть latched: после перехода на backup возврат на primary
  только вручную;
- Channel B/C не становятся automatic fallback для Channel A;
- legacy WireGuard не возвращается в steady-state runtime;
- backup VPS не должен открывать public DNS resolver;
- в emergency mode приоритет — чтобы managed internet работал, а не идеальная
  BrowserLeaks/resolver fingerprint чистота.

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
- [modules/dns-catalog-intelligence/docs/domain-management.md](/modules/dns-catalog-intelligence/docs/domain-management.md)
- [modules/traffic-observatory/docs/traffic-observability.md](/modules/traffic-observatory/docs/traffic-observability.md)
- [modules/traffic-observatory/docs/llm-traffic-runbook.md](/modules/traffic-observatory/docs/llm-traffic-runbook.md)
- [remote-access-overlay-migration.md](remote-access-overlay-migration.md)
- [managed-egress-failover-roadmap.md](managed-egress-failover-roadmap.md)
- [modules/dns-catalog-intelligence/docs/x3mrouting-roadmap.md](/modules/dns-catalog-intelligence/docs/x3mrouting-roadmap.md)
