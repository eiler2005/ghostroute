# Remote Access Overlay Migration

Этот документ фиксирует варианты замены публичного ingress для `wgs1` на альтернативный remote-access слой.

Важно:

- это **planning-only** документ
- в этой итерации **ничего не внедряется**
- цель здесь не "маскировка" трафика, а **снижение внешней поверхности** за счёт отказа от публичного `wgs1` на WAN

## Цель

Текущая схема даёт удобный remote access через raw `WireGuard server` на `wgs1`, но сам `wgs1` является публичным WAN ingress.

Целевое состояние:

- основной remote access идёт через отдельный overlay / zero-trust access layer
- `wgs1` сначала остаётся `backup`
- затем существующие `wgs1` клиенты переводятся на новую схему
- после миграции публичный `wgs1` выключается на WAN

Итоговая цель:

- `wgs1` **не виден вовне**, потому что он больше не принимает основной публичный ingress
- текущий routing catalog (`VPN_DOMAINS`, `VPN_STATIC_NETS`, `RC_VPN_ROUTE`, `wgc1`) остаётся основной внутренней логикой роутера

## Что зафиксировано по live-state

Проверка сделана по live-роутеру **24 апреля 2026**.

### Public surface сейчас

- `wgs1_enable=1`
- `wgs1_port=51820`
- `wgs1` слушает:
  - `udp 0.0.0.0:51820`
  - `udp :::51820`
- `wan0_ipaddr=<wan_public_ip>`
- enabled peer count на `wgs1`: `6`
- у нескольких peer'ов есть свежие handshake

### Дополнительная внешняя поверхность

- web admin выглядит публично доступной через `8443`
- `UPnP` включён
- `SSH` слушает на `0.0.0.0:22`, что требует отдельной WAN-проверки и, вероятно, ужесточения

### Что уже умеет текущий repo

Сейчас routing-layer уже умеет три входящих пути:

- `br0 -> PREROUTING -> RC_VPN_ROUTE -> wgc1 | wan0`
- `wgs1 -> PREROUTING -> RC_VPN_ROUTE -> wgc1 | wan0`
- `OUTPUT -> RC_VPN_ROUTE -> wgc1 | wan0`

См.:

- [architecture.md](architecture.md)
- [current-routing-explained.md](current-routing-explained.md)

### Важное ограничение текущего дизайна

Если новый remote-access путь будет добавлен на роутер, он **не должен** пониматься как "редирект в старый `wgs1`".

Правильная модель:

- новый ingress терминируется на роутере или отдельном gateway
- дальше даёт доступ в LAN / к роутеру
- при необходимости новый ingress отдельно интегрируется в текущий routing-layer

Неправильная модель:

- "внешний front-service на роутере"
- "после этого прозрачный перенос в старый `wgs1`"

Такой подход не убирает архитектурную сложность и обычно не даёт чистого выигрыша.

## Принципы выбора

Для этой задачи важны пять критериев:

1. Можно ли поставить node/agent на `RT-AX88U Pro` с `Asuswrt-Merlin`
2. Есть ли нормальный клиент для `iPhone`
3. Можно ли использовать решение как доступ ко всей домашней LAN, а не только к одному сервису
4. Можно ли держать `wgs1` как `backup` в переходный период
5. Насколько сложно потом полностью выключить публичный `wgs1`

Отдельный критерий:

- onboarding должен быть по возможности простым
- но не стоит ожидать UX "сканируй QR и готово" уровня классического `WireGuard`

## Краткий вывод

Если ориентироваться именно на `RT-AX88U Pro`, iPhone-клиентов и постепенную миграцию с `wgs1`, то shortlist такой:

1. `ZeroTier`
2. `NetBird`
3. `OpenZiti`

По fit для роутера:

- `ZeroTier` выглядит лучшим on-router кандидатом
- `NetBird` выглядит самым дружелюбным для пользовательского onboarding
- `OpenZiti` выглядит самым гибким, но и самым тяжёлым по ops-модели

## Сравнение вариантов

| Вариант | Что это | Реально на роутер | iPhone client | Onboarding | Вся LAN | Как живёт рядом с `wgs1` | Общий вывод |
|---|---|---|---|---|---|---|---|
| `ZeroTier` | overlay-сеть / subnet router | Да, пакет доступен в `Entware/opkg` | Да | app + join network + authorize | Да | Очень хорошо | Лучший практический on-router fit |
| `NetBird` | managed/self-hosted overlay | Да, пакет доступен в `Entware/opkg` | Да | app + login / setup key | Да | Хорошо | Хороший кандидат, особенно ради UX |
| `OpenZiti` | zero-trust overlay / local gateway | Не через `opkg`; manual install, лучше на Pi/VPS | Да | app + enrollment token / JWT | Да | Технически да, но сложнее всех | Мощный, но тяжёлый для Merlin |

## iPhone onboarding

### Что важно понимать заранее

У всех трёх решений есть iPhone-клиенты, но их onboarding модель отличается от raw `WireGuard`.

По состоянию на изучение официальных docs **не найден стандартный официальный UX "как у WireGuard через QR-профиль"** для этих решений как основного сценария.

То есть пользовательский сценарий обычно такой:

- установить приложение
- либо `join network`
- либо `login`
- либо `enroll identity`

### ZeroTier

- официальный iOS-клиент есть
- onboarding обычно выглядит как:
  - установить приложение
  - ввести `Network ID`
  - авторизовать устройство в control plane
- это просто, но не равно WG-style QR

### NetBird

- официальный iOS-клиент есть
- onboarding обычно выглядит как:
  - установить приложение
  - войти через SSO
  - либо использовать `setup key`
- это, вероятно, самый понятный UX для обычного пользователя

### OpenZiti

- официальный iOS-клиент есть
- onboarding обычно выглядит как:
  - установить приложение
  - получить `one-time token` / `JWT`
  - пройти enrollment
- это мощно, но заметно сложнее для бытового сценария

## Что можно ставить на этот роутер

На live-роутере обнаружено:

- `Entware` установлен
- архитектура: `aarch64`
- в `opkg` доступны:
  - `zerotier`
  - `netbird`
  - `nebula`
  - `tailscale`
  - `headscale`

Из рассматриваемого shortlist это означает:

- `ZeroTier`: практично ставить прямо на роутер
- `NetBird`: практично ставить прямо на роутер
- `OpenZiti`: лучше не на Merlin, а на `Raspberry Pi` или другой Linux-хост

## Как это будет связано с текущим routing-layer

Сейчас для remote-трафика с `wgs1` уже есть:

- `PREROUTING -i wgs1 -j RC_VPN_ROUTE`
- DNS redirect для `wgs1 -> dnsmasq`

Если новый overlay будет давать remote-клиентам не только доступ к роутеру, но и **тот же split-routing semantics**, что у `wgs1`, то на этапе implementation почти наверняка понадобится:

1. определить точное имя интерфейса нового решения на роутере
2. добавить аналогичный ingress hook:
   - `PREROUTING -i <new_overlay_if> -j RC_VPN_ROUTE`
3. при необходимости добавить DNS redirect в локальный `dnsmasq`
4. расширить `verify.sh` / `router-health-report` под новый ingress

Это особенно важно, если хочется, чтобы remote-клиент через новый access path:

- тоже использовал `VPN_DOMAINS`
- тоже использовал `VPN_STATIC_NETS`
- тоже наследовал текущую split-routing логику

Если новый канал нужен только как:

- доступ к роутеру
- SSH
- web UI
- доступ к отдельным внутренним хостам

то интеграция в `RC_VPN_ROUTE` может быть не нужна сразу.

## Вариант 1: ZeroTier on router + wgs1 backup

### Почему этот вариант сильный

- пакет уже доступен на роутере
- модель "overlay + subnet router" хорошо подходит для домашней LAN
- iPhone-клиент есть
- rollout можно сделать постепенно, не ломая существующих `wgs1` клиентов

### Сильные стороны

- лучший fit для `Merlin + Entware`
- хороший баланс между простотой и возможностями
- можно начать без изменений у текущих `wgs1` peer'ов

### Слабые стороны

- onboarding не такой простой, как WG QR
- потребуется отдельная routing decision:
  - только доступ к LAN
  - или доступ к LAN + наследование split-routing catalog

### Migration plan

#### Phase 0. Подготовка

- ничего не менять в `wgs1`
- зафиксировать текущий health snapshot:
  - `./verify.sh`
  - `./scripts/traffic-report`
  - `./scripts/router-health-report --save`
- отдельно подготовить hardening backlog:
  - WAN admin off
  - WAN SSH LAN-only
  - review `UPnP`

#### Phase 1. Лабораторный запуск ZeroTier на роутере

- установить `zerotier` на роутер
- поднять node в отдельной overlay-сети
- подключить один тестовый iPhone
- проверить:
  - доступ к роутеру
  - доступ к одному LAN-host
  - стабильность CPU/RAM на роутере

#### Phase 2. Определить режим

Выбрать один из двух режимов:

- `mode A`: только admin / LAN access без интеграции в `RC_VPN_ROUTE`
- `mode B`: remote-клиенты через ZeroTier должны использовать ту же split-routing логику, что и `wgs1`

Для `mode B` понадобится отдельная реализация в repo:

- hook на новый overlay interface
- возможно, DNS redirect
- новые health checks

#### Phase 3. Параллельная эксплуатация

- `wgs1` остаётся основным для старых клиентов
- новые тестовые клиенты заходят через ZeroTier
- собираются smoke-checks:
  - router access
  - LAN access
  - DNS behavior
  - routing behavior

#### Phase 4. Перевод клиентов

- начать выдавать новым пользователям ZeroTier вместо `wgs1`
- существующих `wgs1` клиентов переводить по одному
- держать простой operational checklist:
  - кто переведён
  - кто ещё на `wgs1`
  - есть ли клиенты, которым нужен rollback

#### Phase 5. Сведение `wgs1` к backup

- после перевода основной массы клиентов оставить `wgs1` только как backup
- проверить, действительно ли есть клиенты, которым он ещё нужен

#### Phase 6. Выключение публичного `wgs1`

- отключить `wgs1` на WAN
- ещё раз прогнать:
  - `./verify.sh`
  - `./scripts/traffic-report`
  - `./scripts/router-health-report --save`
- обновить docs/runbook

### Вердикт

Это **главный кандидат** для on-router migration path.

## Вариант 2: NetBird on router + wgs1 backup

### Почему этот вариант интересен

- пакет уже доступен на роутере
- хороший iPhone UX
- лучше подходит, если хочется более "человеческий" onboarding

### Сильные стороны

- iPhone onboarding выглядит проще, чем у OpenZiti
- достаточно естественный путь для постепенной миграции пользователей
- можно жить рядом с `wgs1` во время перехода

### Слабые стороны

- on-router fit выглядит менее очевидным и менее "домашне-роутерным", чем ZeroTier
- потребуется аккуратно проверить, как именно агент ведёт себя на Merlin
- для self-hosted / control plane история сложнее, чем у ZeroTier

### Migration plan

#### Phase 0. Подготовка

Та же, что и у ZeroTier:

- ничего не ломать в `wgs1`
- снять baseline health/reporting

#### Phase 1. Лабораторный запуск NetBird на роутере

- установить `netbird`
- подключить роутер как peer
- подключить один тестовый iPhone
- проверить:
  - вход на роутер
  - доступ к одному LAN-host
  - стабильность работы агента

#### Phase 2. Определить режим доступа

Выбрать:

- только admin / jump access
- или полноценный доступ к LAN

Если нужен режим "как у `wgs1` по split-routing semantics", то понадобится интеграция в repo:

- новый ingress hook
- возможно, DNS redirect
- новые checks/reporting

#### Phase 3. Параллельный rollout

- старые `wgs1` клиенты пока не трогаются
- часть пользователей переводится на NetBird
- собираются UX и stability feedback:
  - насколько просто подключать iPhone
  - насколько стабилен доступ
  - нужен ли отдельный control plane

#### Phase 4. Массовый переход

- всем новым пользователям выдаётся NetBird onboarding
- старые `wgs1` клиенты переводятся постепенно
- ведётся список rollback-critical устройств

#### Phase 5. `wgs1` как backup

- когда большая часть клиентов переехала, `wgs1` остаётся только как аварийный вход

#### Phase 6. Отключение публичного `wgs1`

- после полного перехода `wgs1` выключается на WAN
- docs и health/runbook обновляются

### Вердикт

Хороший кандидат, особенно если главным критерием будет **простота пользовательского onboarding**, а не максимальная "роутерность" решения.

## Вариант 3: OpenZiti gateway + wgs1 backup

### Почему этот вариант вообще в shortlist

- модель local gateway / zero-trust overlay очень хорошо ложится на задачу "новый ingress без публичного `wgs1`"
- можно строить доступ к LAN и сервисам заметно гибче, чем в обычном overlay

### Почему это не лучший on-router путь

- на роутере пакет не обнаружен через `opkg`
- manual install на `Merlin` будет сложнее и рискованнее
- onboarding для пользователей сложнее
- операционная модель тяжелее

### Сильные стороны

- очень гибкая gateway-модель
- хорошо подходит для сценариев с избирательным доступом к сети/сервисам

### Слабые стороны

- из всех вариантов самый высокий ops-cost
- больше всего шансов, что правильнее будет ставить не на роутер, а на `Raspberry Pi`
- onboarding заметно менее бытовой, чем у ZeroTier или NetBird

### Migration plan

#### Phase 0. Подготовка

- зафиксировать baseline
- ничего не менять в `wgs1`

#### Phase 1. Принять архитектурное решение

Сначала решить:

- ставить ли OpenZiti вообще на роутер
- или признать, что правильный вариант для него это `Raspberry Pi`

Для Merlin приоритетно рассматривать второй путь.

#### Phase 2. Поднять gateway и один тестовый клиент

- развернуть controller / router / gateway topology
- подключить один iPhone
- проверить:
  - enrollment
  - доступ к роутеру
  - доступ к одному LAN-host

#### Phase 3. Решить вопрос с routing integration

Если нужен не только admin access, а полноценный remote ingress в текущую split-routing модель, потребуется отдельная интеграция интерфейса/туннеля OpenZiti в repo.

#### Phase 4. Параллельная эксплуатация

- старые `wgs1` клиенты не трогаются
- ограниченное число новых пользователей идёт через OpenZiti
- собирается operational feedback

#### Phase 5. Ограниченная миграция

- OpenZiti становится основным только если его реально удобно сопровождать
- иначе migration path останавливается и решение отклоняется

#### Phase 6. Выключение `wgs1` только после полного успеха

- если migration path оказался успешным и onboarding acceptable, только тогда `wgs1` уходит из роли публичного ingress

### Вердикт

Сильная архитектурная идея, но **не лучший стартовый вариант именно для on-router deployment на Merlin**.

## Рекомендованная последовательность выбора

1. Сначала проверить `ZeroTier`
2. Если UX для пользователей критичнее всего, параллельно оценить `NetBird`
3. `OpenZiti` держать как архитектурно сильный, но более поздний или `Raspberry Pi`-ориентированный путь

## Как переводить текущих `wgs1` клиентов

### Что важно

Если конечная цель — убрать публичный `wgs1`, то старые клиенты **нельзя оставить навсегда без изменений**.

Придётся:

- выдать новый способ подключения
- помочь людям установить новое приложение
- пройти onboarding нового решения

Старые `wgs1` профили после выключения публичного `wgs1` работать не будут.

### Практичная стратегия миграции

1. Оставить `wgs1` без изменений на старте
2. Поднять новый overlay параллельно
3. Подключить один тестовый iPhone и один ноутбук
4. После этого выдавать новым пользователям уже новый способ входа
5. Старых `wgs1` пользователей переводить по одному
6. Вести список:
   - кто уже мигрирован
   - кто остаётся на `wgs1`
   - кому нужен rollback
7. Когда все критичные пользователи переехали, отключить публичный `wgs1`

### На что обратить внимание в UX

- у новых решений onboarding почти наверняка будет не "QR как у WireGuard"
- придётся делать более человеческую инструкцию:
  - установить приложение
  - войти / join / enroll
  - проверить доступ

Для бытового сценария это делает `NetBird` и `ZeroTier` заметно привлекательнее `OpenZiti`.

## Что не делать

- не ставить на роутер тяжёлый control plane, если можно поставить только agent/node
- не смешивать "новый front-service" и "редирект в старый `wgs1`"
- не выключать `wgs1` до тех пор, пока новая схема не прожила параллельно и не показала стабильность
- не считать, что новая схема автоматически наследует текущую `wgs1` split-routing интеграцию без явной работы в repo

## Рекомендуемый стартовый путь

Если нужен один рабочий стартовый вариант без новой железки:

- **ZeroTier on router**
- `wgs1` оставить как backup
- позже перевести клиентов
- затем выключить публичный `wgs1`

Если окажется, что решающий фактор — простота iPhone onboarding:

- отдельно сравнить pilot `ZeroTier` и `NetBird`

Если окажется, что нужен более строгий zero-trust/gateway подход:

- рассматривать `OpenZiti`, но уже с сильным уклоном в `Raspberry Pi`, а не в Merlin

## Официальные источники

### ZeroTier

- iOS / iPadOS: <https://docs.zerotier.com/ios>
- iOS FAQ: <https://docs.zerotier.com/faq-ios/>
- Route between ZeroTier and Physical Networks: <https://docs.zerotier.com/route-between-phys-and-virt/>

### NetBird

- iOS app: <https://docs.netbird.io/get-started/install/ios>
- Install / platform docs: <https://docs.netbird.io/how-to/installation>
- Getting started / onboarding: <https://docs.netbird.io/how-to/getting-started>

### OpenZiti

- iOS tunneler: <https://openziti.io/docs/reference/tunnelers/iOS/>
- Linux router deployment: <https://openziti.io/docs/guides/deployments/linux/router/deploy/>
- Router as local gateway: <https://openziti.io/docs/guides/topologies/gateway/router/>
- Tunneler as local gateway: <https://openziti.io/docs/guides/topologies/gateway/tunneler/>
- Router configuration reference: <https://openziti.io/docs/reference/configuration/router/>
- Identity enrollment concepts: <https://openziti.io/docs/learn/core-concepts/identities/enrolling/>

### Teleport

Teleport intentionally не включён в основной migration shortlist для этой задачи, потому что он лучше подходит для access-to-resources / bastion-like use case, а не для замены `wgs1` как бытового remote ingress ко всей LAN.

- Linux install: <https://goteleport.com/docs/installation/linux>
- Agent architecture / reverse tunnel: <https://goteleport.com/docs/reference/architecture/agents/>
