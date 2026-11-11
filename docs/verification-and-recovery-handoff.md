# Проверка и восстановление: передача в эксплуатацию

Документ связывает реализованные компоненты, их проверки и приватные материалы
восстановления. Текущие соответствия приложений выходам, адреса и результаты
конкретного deploy хранятся отдельно от публичной документации.

## Владельцы и документация

| Область | Что реализовано | Где проверять и восстанавливать |
|---|---|---|
| Маршрутизация | Managed/direct split, sensitive policy, отдельные ingress и selected full-VPS | [Принципы](routing-policy-principles.md), [каналы](channels.md), [sensitive mode](../modules/routing-core/docs/sensitive-sites-mode.md) |
| Смена выхода приложения | Изолированная квалификация кандидата до изменения production, ручное применение и откат | [Egress qualification](../modules/ghostroute-health-monitor/docs/egress-qualification.md) |
| Мобильные клиенты | Home-first профили и общая post-router policy; отдельная проекция Amn | [Операции с каналами](../modules/routing-core/docs/channel-routing-operations.md), [Amn](../modules/routing-core/docs/channel-amn-research.md) |
| Mac Guard | SwiftUI, обычный Chrome с обязательным проверяемым маршрутом каталога, внешний PAC и optional browser | [Пользовательское руководство](../modules/mac-privacy-guard/docs/user-guide.md), [тесты](../modules/mac-privacy-guard/tests/README.md), [обновление/rollback](../modules/mac-privacy-guard/docs/operations.md) |
| Наблюдение | Read-only health и traffic-facts; события Guard и scoped HTTP-диагностика | [Health runbook](../modules/ghostroute-health-monitor/docs/stealth-monitor-runbook.md), [traffic](../modules/traffic-observatory/docs/traffic-observability.md) |
| Приватное состояние | Vault, профиль Guard, совместимые клиентские артефакты и зашифрованные recovery bundles | [Secrets](../modules/secrets-management/docs/secrets-management.md), [backup contract](../modules/secrets-management/docs/vault-offsite-backup.md) |

Установка Guard не является deploy роутера. Изменение браузерного proxy не меняет
маршрут native-приложения на телефоне. Смена server-side egress не требует новых
импортов, пока ingress, транспорт и credentials сохраняются; их изменение —
отдельная согласованная миграция.

## Что сохранять после изменения

Приватная запись оператора должна связывать source revision, проверенную версию
приложения/расширения, desired-state selectors и фактически применённую policy.
Для маршрута указываются роль backend, scope клиентов, квалификация до применения,
результат после него и состояние реальной клиентской приёмки. Для эксперимента
добавляются ручная дата пересмотра и критерии отката; запись даты не запускает
таймер и не переключает маршрут автоматически.

До изменения сохранить прежние совместимые конфигурации и encrypted Vault.
После него сверить canonical render с live policy; обновить активную проекцию
Amn и её локальные generated artifacts, если изменился источник. Отдельно
зафиксировать, какие соединения/сервисы перезапускались. Не считать успешный
процесс, handshake или canary доказательством загрузки медиа реальным клиентом.

## Копии: исходники, конфигурация и инфраструктура

| Материал | Что позволяет восстановить | Ограничение |
|---|---|---|
| Git checkout | Код, шаблоны, тесты, общие каталоги и runbooks | Не содержит действующих credentials или полного deployment inventory |
| Encrypted Vault и совместимые артефакты | Параметры инфраструктуры и клиентские identities | Нужны независимо восстанавливаемые средства расшифровки |
| Router/VPS recovery bundle | Сохранённое состояние компонентов в пределах manifest | Архив конфигурации не равен полному образу диска/инфраструктуры |
| Приватный профиль Guard | TLS trust, approved exit, credentials и allowlist | Включать в зашифрованную копию явно; приложение само не создаёт offsite backup |
| Bundle приложения для отката | Прежний executable и его ресурсы | Нужны совместимый Python и профиль; это не копия роутера/VPS |
| Browser profile / внешний PAC | Browser sessions и настройки браузера | Содержат приватные данные; не входят в обычный диагностический отчёт |

Проверка backup означает расшифровку, проверку manifest/содержимого и приёмку
предусмотренного restore path. Само наличие файла недостаточно. Копия на том же
Mac остаётся локальной даже при шифровании; независимая копия и реальные restore
drills фиксируются отдельно. Не обещать восстановление всех машин из одного
архива, если manifest этого не покрывает. Runtime PID/socket/lock не переносить.

## Завершение изменения

1. Выполнить узкие fixtures изменённого контракта; для Guard выбрать проверки
   из его test guide, для маршрута — qualification и policy tests.
2. Сохранить приватный rollback и применить только согласованный scope.
3. Проверить фактический runtime, относящиеся к нему health-инварианты и реальные
   запросы. После перезапуска Amn проверять также готовность TUN и порядок LAN
   guard, не отключая защиту ради прохождения проверки.
4. Отделить автоматические проверки от ручной приёмки: выбранные мобильные
   устройства, сообщения/медиа, sleep/wake и смена сети требуют своих результатов.
5. Обновить соответствующие публичные инструкции и приватную запись. Перед
   разрешённым commit/push выполнить secret-scan. Desired state из Vault и raw
   evidence не переносить в Git ради создания коммита.

Если изменились только приватные selectors, отсутствие публичного diff нормально.
Если изменился только текст/тесты, deployment работающего runtime не требуется.
Успех CI конкретного модуля не означает успех всего репозитория или всех живых
каналов. Условия дополнительной приёмки и реальные долги находятся в
[Routing Assurance Roadmap](routing-assurance-roadmap.md).
