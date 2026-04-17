# Tests

Этот каталог покрывает **безопасный observability / health-reporting слой**, который работает поверх живой конфигурации роутера и не меняет runtime.

Главная идея:

- не тестировать `dnsmasq`, `iptables`, `ip rule` через локальные unit-тесты
- тестировать parser/formatter-логику и стабильность CLI-слоя
- оставлять live-проверки отдельным smoke-этапом

Иными словами:

- `tests/` проверяет, что мы **правильно читаем, интерпретируем и рендерим уже собранные данные**
- `tests/` не пытается эмулировать весь роутер ASUS/Merlin локально
- фактическое состояние роутера подтверждается отдельными live-командами

## Что здесь есть

### `tests/test-router-health.sh`

Fixture-based smoke test для health-reporting слоя.

Это не unit-тест в строгом framework-смысле, а короткий shell smoke-test, который специально:

- быстрый
- без внешних зависимостей
- не требует живого роутера
- падает сразу при первом несоответствии

Что он проверяет:

1. `router_collect_capacity_history`
   - умеет читать локальный journal snapshot
   - достаёт latest snapshot
   - достаёт week-old snapshot
   - не ломается на формате таблицы capacity snapshot

   Почему это важно:
   - health-report опирается на local journal для growth delta
   - если parser этого блока ломается, `router-health-report` перестаёт честно показывать рост каталога
   - такие поломки легко случайно внести обычной правкой текста в journal section

2. `router_extract_traffic_summary`
   - умеет парсить стабильные секции из `traffic-report`
   - достаёт `Router-wide window`
   - достаёт `Per-device byte window`
   - достаёт totals и `Device Traffic Mix`
   - опирается на то, что peer-top секции (`Top by WG server peers`, `Top by Tailscale peers`) остаются стабильной частью общего summary-контракта

   Почему это важно:
   - `router-health-report` не пересчитывает traffic totals сам, а читает стабильный summary из `traffic-report`
   - если сломается парсинг этих строк, health-report станет давать пустые или вводящие в заблуждение traffic sections
   - это как раз тот тип regressions, который тяжело заметить “на глаз”, если не иметь fixture-теста

3. `router_render_health_markdown`
   - собирает итоговый sanitised Markdown
   - действительно рендерит ключевые секции:
     - `Router Health Latest`
     - `Catalog Capacity`
     - `Growth vs latest saved snapshot`
     - `Growth level / Growth note`
     - `Freshness`
     - `Traffic Snapshot`
     - `Drift`
     - `Notes`

Зачем это нужно:

- чтобы refactor helper-логики не ломал формат health-report
- чтобы LLM и человек продолжали видеть устойчивую структуру секций
- чтобы parser для journal/traffic-summary не “тихо” развалился после правок текста

Что именно этот тест сознательно НЕ проверяет:

- числовую “истинность” live-данных роутера
- что `ssh` вообще доступен
- что на роутере есть нужные файлы snapshots
- что маршрутизация реально применена в kernel

Это сделано специально: иначе локальный тест стал бы хрупким и зависимым от текущего состояния домашней сети.

### `tests/fixtures/router-health/`

Фикстуры для smoke-теста:

- `journal-sample.md`
  sample local journal с capacity snapshots
- `traffic-report-sample.txt`
  sample stable traffic-report output
- `state-sample.env`
  sample key=value state для markdown renderer

Зачем фикстуры нужны:

- они позволяют тестировать formatting/parsing без живого роутера
- тесты остаются быстрыми и воспроизводимыми
- можно безопасно дорабатывать renderer, не трогая runtime
- они фиксируют **контракт формата** между:
  - local journal
  - traffic-report stable summary
  - health markdown renderer

Подробности по каждому fixture-файлу: [fixtures/router-health/README.md](fixtures/router-health/README.md)

### `tests/test-catalog-review.sh`

Fixture-based smoke test для advisory review слоя `scripts/catalog-review-report`.

Что он проверяет:

1. Что report рендерится без живого роутера.
2. Что в output есть стабильные секции:
   - `Static Coverage Review`
   - `Domain Coverage Review`
   - `Recommendation Mode`
3. Что широкий static CIDR попадает в advisory summary.
4. Что child-domain, уже покрытый parent-rule, попадает в cleanup-candidates.

Подробности по fixture-файлам: [fixtures/catalog-review/README.md](fixtures/catalog-review/README.md)

## Контракт, который мы защищаем тестами

Тестовый слой по сути защищает три текстовых интерфейса:

1. `docs/vpn-domain-journal.md` как источник saved capacity snapshots
2. `traffic-report` / `traffic-daily-report` как stable text summaries
3. `router-health-report` как sanitised Markdown output для человека и LLM

Если один из этих интерфейсов ломается, последствия такие:

- LLM начинает неверно интерпретировать состояние роутера
- tracked `docs/router-health-latest.md` теряет полезность
- growth deltas по каталогу становятся пустыми или ложными
- operational troubleshooting становится медленнее

## Что эти тесты НЕ проверяют

Они не проверяют:

- живой `ssh` до роутера
- фактическое состояние `ipset` / `iptables` / `ip rule`
- что `dnsmasq` уже применил правила
- что WGC1/WGS1 реально передаёт трафик

Для этого нужны отдельные live smoke-команды.

## Как запускать

Синтаксис shell-скриптов:

```bash
bash -n verify.sh scripts/router-health-report scripts/traffic-report scripts/traffic-daily-report scripts/lib/router-health-common.sh tests/test-router-health.sh
bash -n scripts/catalog-review-report tests/test-catalog-review.sh
```

Fixture smoke test:

```bash
./tests/test-router-health.sh
./tests/test-catalog-review.sh
```

Ожидаемый успешный вывод:

```txt
router-health fixture smoke tests passed
```

Если тест падает:

- сначала посмотрите, на каком `assert_*` он остановился
- затем сравните:
  - что изменилось в `scripts/lib/router-health-common.sh`
  - не поменялся ли формат stable sections в `traffic-report`
  - не поменялся ли формат capacity snapshot в journal

Live smoke:

```bash
./verify.sh
./verify.sh --verbose
./scripts/traffic-report
./scripts/traffic-daily-report week
./scripts/router-health-report
./scripts/router-health-report --save
./scripts/catalog-review-report
./scripts/catalog-review-report --save
```

## Почему тестовый слой устроен именно так

Проект управляет домашним роутером и живым routing runtime. Поэтому безопаснее разделять проверки на два уровня:

1. `fixture + syntax`
   - быстрые
   - повторяемые
   - не трогают роутер

2. `live smoke`
   - читают реальное состояние роутера
   - подтверждают, что observability-слой совпадает с живой системой
   - не меняют runtime-конфигурацию

Такой баланс даёт полезную автоматизацию без лишнего риска для рабочего роутера.

## Что делать при расширении тестов

Если добавляете новый stable block в `router-health-report` или меняете текстовый контракт:

1. сначала обновите соответствующий fixture
2. потом обновите `tests/test-router-health.sh`
3. затем прогоните:
   ```bash
   ./tests/test-router-health.sh
   ./verify.sh
   ./scripts/router-health-report
   ```
4. только после этого меняйте документацию под новый формат

Это помогает держать единый контракт между кодом, docs и live-операциями.
