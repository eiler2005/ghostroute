# Проверки GhostRoute Guard

Команды выполняются из корня репозитория. Тесты используют вымышленные
назначения, временные профили и локальные TLS endpoints. Они не требуют Vault,
доступа к роутеру/VPS или изменения рабочего профиля Chrome.

## Автоматические проверки

| Команда | Что доказывает |
|---|---|
| `./modules/mac-privacy-guard/tests/run.sh` | Python policy/TLS/gate/API/Native Messaging, отмена проверки, закрытие туннелей, изоляция агентов и имитация разрыва времени после сна |
| `node modules/mac-privacy-guard/tests/pac.mjs` | Приоритет каталога перед внешним PAC, suffix-границы, исходные bypass/fallback правила, восстановление снимка и ограничение размера |
| `node modules/mac-privacy-guard/tests/counts.mjs` | Badge до четырёх символов, десятичная запятая, компактные единицы и точные числа с разделителями |
| `node modules/mac-privacy-guard/tests/diagnostics.mjs` | Подготовленная вкладка, отзыв доступа, solicited preview, лимиты и удаление данных; инертное отображение HTML |
| `swift run --package-path modules/mac-privacy-guard/native GuardNativeChecks` | Типизированные контракты, bootstrap/token, отказ API, startup/retry, состояние UI и команды Chrome |
| `node modules/mac-privacy-guard/tests/browser.mjs` | Совместимость протокола без strict provider, доставка allow/block, popup и desktop IPC, budget локального переключения, отдельный fixed-proxy браузер и negative-path проверки |
| `node modules/mac-privacy-guard/tests/strict-browser.mjs` | Реальный обычный Chromium со strict provider: qualification, mandatory PAC/privacy, реальные туннели, отдельный внешний proxy с авторизацией, Close/Resume, конфликты, отказ gate/engine и отсутствие direct retry для каталога |
| `swift build --package-path modules/mac-privacy-guard/native --configuration release --product GhostRouteGuard` | Компиляция приложения; отдельно от приёмки установленного окна и маршрута |

`run.sh` запускает только Python; он не заменяет Swift/JS/browser проверки.
Python также проверяет приватные ordinary exceptions: права, владельца,
символические ссылки, лимиты и запрет пересечений с sensitive-каталогом.
`strict-browser.mjs` воспроизводит CONNECT 503: непроверенный сайт остаётся
на отказавшем proxy, отдельно проверенный ordinary site открывается напрямую,
а sensitive сохраняет обязательный gate. `browser.mjs` проверяет popup при
многомиллионных счётчиках в viewport 380×600, точные подсказки и раскрытие деталей.
Strict fixture проверяет зелёный подтверждённый статус, его смену при паузе,
отступ между группами действий и отсутствие переполнения в светлой/тёмной теме.
Выбирайте проверки по изменённому контракту. При изменении proxy, relay, доступа
или installer нужны соответствующие реальные browser fixtures до установки.
При изменении только документации достаточно проверить её ссылки и сверить
описанное поведение с существующими проверками.

Для отдельного каталога Swift build добавьте
`--scratch-path reports/mac-guard-checks/swift-build` после пути package.
Результаты и скриншоты browser fixtures можно сохранить так:

```bash
GUARD_REPORT_DIR=reports/mac-guard-checks/legacy \
  node modules/mac-privacy-guard/tests/browser.mjs
GUARD_REPORT_DIR=reports/mac-guard-checks/strict \
  node modules/mac-privacy-guard/tests/strict-browser.mjs
```

## Подготовка Chromium

Нужны Python 3.11+, Node, OpenSSL и Playwright с подходящим Chromium.
На Mac для Swift нужны Command Line Tools. По умолчанию browser fixtures
находят Playwright в существующем dev installation Console; Console не запускается
и его код/зависимости не меняются. Альтернатива — отдельная установка:

```bash
npm install --prefix reports/mac-guard-test-tools --ignore-scripts --no-audit --no-fund playwright@1.59.1
node reports/mac-guard-test-tools/node_modules/playwright/cli.js install chromium
GUARD_PLAYWRIGHT="$PWD/reports/mac-guard-test-tools/node_modules/playwright" \
  node modules/mac-privacy-guard/tests/strict-browser.mjs
```

Только `browser.mjs` поддерживает `GUARD_CHROME` для выбора executable; строгий
fixture использует Playwright Chromium. Настоящий Chromium sandbox включён.
Временные сертификаты и test-only certificate bypass остаются внутри fixtures;
в production launcher таких флагов нет. Второе тестовое расширение имеет
`webRequestAuthProvider`/host access исключительно для fake proxy authentication;
у реального Guard этих разрешений нет.

## Матрица доказательств

| Контракт | Основное доказательство | Что проверять отдельно |
|---|---|---|
| TLS и доверенный выход | Полный TLS-in-TLS canary, wrong pin/CA/exit rejection | Доверенный источник реального pin/IP и deployed sensitive policy |
| Закрытие доступа | Unit generation/cancellation и реальные browser отказы; Close закрывает принадлежащие gate туннели | Существующие чужие/direct соединения не принадлежат gate |
| Независимость профилей | Два активных агента, Close первого сохраняет второй и не активирует optional browser | Установка и разрешения каждого реального профиля/Incognito |
| Сон и устаревание | Имитация паузы времени закрывает существующий туннель до новой qualification | Настоящие sleep/wake, roaming и reboot на выбранной macOS |
| Одновременный внешний PAC | HTTP/HTTPS через отдельный fake proxy с авторизацией; sensitive идёт только через Guard; Close сохраняет внешний путь | Версия/страна реального провайдера, новый снимок после изменения правил |
| Локальная скорость | `browser.mjs`: 16 desktop и 8 popup переключений, менее 2 секунд каждое | Это legacy protocol fixture без qualification; не SLA удалённого strict route и не замер реального сайта |
| HTTP-диагностика | Настоящий extension/native/control path плюс scoped callback fixtures | Видимость и lifecycle настоящей панели DevTools; callbacks её не заменяют |
| Граница каталога | UDP и reviewed TURN tripwires; отдельный тест разрешённого TURN TCP вне каталога | Неизвестные зависимости, другие приложения и whole-tab изоляция не покрыты |

## CI и выпуск

Иллюстрации документации имеют отдельную воспроизводимую проверку:

```bash
python3 modules/mac-privacy-guard/tools/build-diagrams.py
node modules/mac-privacy-guard/tools/render-diagrams.cjs
```

Она использует уже установленный Playwright, проверяет шесть RU/EN фигур и
экспортирует PNG: доступные названия, размеры подписей, прохождение соединителей,
сложность, горизонтальную прокрутку только внутри схем на телефоне и печать.
`GUARD_PLAYWRIGHT` выбирает библиотеку, `GUARD_DIAGRAM_BROWSER=chromium` —
установленный Chromium; default — локальный Chrome. Исходники, ограничения
упрощения и prompt GPT Image обложки находятся в
[каталоге схем](../../../docs/assets/diagrams/README.md#mac-guard-diagrams-and-cover).

[Отдельный workflow модуля](../../../.github/workflows/mac-privacy-guard.yml)
запускает unit/JS на Ubuntu, Swift/browser/build на macOS и сохраняет fixture
evidence как артефакт. Его успех не означает успех общего CI репозитория и не
проверяет реальную инфраструктуру. Число тестов и run URL записываются в приватный
release report, а не используются как постоянная характеристика версии.

Перед заменой установленного приложения нужны release build, проверка подписи,
копия прежнего bundle и сохранение приватного профиля. После установки отдельно
проверяются версия расширения, фактический основной статус, реальный запрос и
байты туннеля. Не отключайте рабочие защиты ради зелёного теста.

Результаты живых проверок, endpoints и профили хранятся только в игнорируемых
операторских материалах. Подробности: [модель угроз](../docs/security-and-testing.md),
[строгий режим](../docs/strict-mode.md), [runbook](../docs/operations.md).
