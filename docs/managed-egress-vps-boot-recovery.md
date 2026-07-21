# Managed egress: VPS boot-order и recovery

> **`[RU primary]`** — постоянный runbook для случая, когда managed-трафик
> перестал работать из LAN/Wi-Fi и home-first Channels A/B/C, но часть
> control-plane ещё доступна. Он намеренно не содержит адресов, профилей,
> идентификаторов клиентов, секретов или сырых incident-логов.

## Граница инцидента

GhostRoute отвечает за data-plane: router-side split, Reality egress, Unbound
для managed DNS и edge-контейнеры. Доступ по SSH, открытый порт в firewall
провайдера или живая панель VPS **не** доказывают, что managed HTTPS проходит.
Первое доказательство всегда строится на активной проверке из этого репозитория:

```bash
./modules/ghostroute-health-monitor/bin/live-check --json --active-probe channel-a
```

Инцидент относится к VPS managed-egress пути, если одновременно выполняются
следующие признаки:

- `active_managed_egress` или active managed HTTP-проверка не проходят;
- direct/control-проверки продолжают проходить;
- router-side listeners и DNS-классификация не указывают на локальную поломку;
- тот же симптом виден у нескольких Channel A/B/C клиентов или LAN/Wi-Fi.

Такой набор отделяет проблему VPS/edge от LTE-оператора, отдельного iPhone
профиля или одного домена. Если ломается только один клиент, сначала проверьте
его Layer-0 профиль, DNS-cache и IPv6 ownership; этот runbook не заменяет
клиентскую диагностику.

## Причина, которую должен предотвращать этот контракт

Зафиксированный класс отказа — цикл порядка запуска `systemd`:

```text
resolver waits for Docker bridge
Docker waits for nss-lookup.target
resolver participates in nss-lookup.target
```

Он появляется, когда guarded resolver получает `After=`/`Wants=` на Docker,
а Docker unit (или его vendor/default dependency) ждёт
`nss-lookup.target`, который обеспечивает тот же resolver. `systemd` может
разорвать цикл эвристически, но это не даёт гарантированного boot order:
Docker либо edge-контейнеры могут не запуститься, а managed egress останется
недоступным до ручного вмешательства.

Нормальный инвариант:

1. Docker не ждёт lookup target, который предоставляет resolver, зависящий от
   Docker bridge.
2. Resolver может ждать появления Docker bridge до запуска.
3. Единственный источник конфигурации этого исключения — роль
   `vps_unbound`; старый Docker drop-in для bridge guard не должен оставаться.

Когда bridge guard включён, роль рендерит контролируемый Docker unit без этой
циклической зависимости и удаляет устаревший drop-in. Не редактируйте unit
вручную на VPS: следующий deploy или обновление пакета сделает такую правку
непредсказуемой.

## Быстрая классификация без изменений runtime

Сначала сохраните только санитизированный результат активной проверки, затем
на VPS выполните read-only команды с role names:

```bash
sudo systemctl is-active docker
sudo systemctl is-active <resolver-service>
sudo systemctl show -p After docker.service
sudo systemctl cat docker.service
sudo journalctl -b -u docker -u <resolver-service> --no-pager
sudo docker ps --format '{{.Names}} {{.Status}}'
```

Признаки именно boot-order проблемы:

- в журнале текущей загрузки есть `ordering cycle` или `dependency cycle`;
- Docker или resolver не active после boot;
- edge-контейнер отсутствует либо не запущен, хотя router-side маршрут здоров;
- после точечного восстановления services active, и активная managed
  HTTP-проверка снова зелёная.

Не путайте две независимые firewall-плоскости:

- firewall провайдера определяет, может ли нужный data-plane reach listener
  снаружи;
- host UFW определяет, может ли конкретный operator source открыть SSH или
  другой host listener.

Проверяйте обе, но не добавляйте широкие allow-правила. Временное разрешение
допустимо только для одного подтверждённого источника, на короткое окно
восстановления, с явным удалением правила и повторной загрузкой политики после
работ. Оно не является лечением data-plane.

## Порядок recovery

1. Сначала выполните `live-check --json --active-probe channel-a` и сохраните
   только статусы probes. Не меняйте client profiles и не включайте fallback
   только потому, что SSH отвечает.
2. Проверьте provider firewall и UFW отдельно. Не отключайте UFW и не
   расширяйте доступ до «any source».
3. Если normal boot недоступен, используйте provider console/rescue только для
   возврата read-only доступа и исправления подтверждённого service-order
   дефекта. Не запускайте очистку Docker, `compose down`, volume prune или
   массовый restart.
4. Проверьте фактический unit graph. Если в текущем boot найден цикл,
   исправление должно быть внесено в `vps_unbound` роль, локально проверено и
   применено только с явным operator approval.
5. После восстановления проверьте конкретные components, а не «весь stack»:
   Docker, resolver, edge proxy и edge runtime должны быть active/running.
6. Повторите активную managed egress и managed HTTP-проверки. Считать инцидент
   закрытым можно лишь когда они зелёные вместе с direct control.

Обычный post-fix deploy flow остаётся прежним: сначала локальный syntax/static
check, затем явное разрешение на mutating Ansible operation, затем read-only
verification. Во время самого outage не обходите deploy gate без отдельного
обоснованного emergency решения.

## После обновления Docker или systemd

Полный контролируемый Docker unit намеренно защищает boot graph, но vendor unit
может меняться при пакетном обновлении. До следующего reboot/restart Docker
проверьте:

```bash
sudo systemctl cat docker.service
sudo systemctl show -p After docker.service
sudo systemd-analyze verify docker.service <resolver-service>
sudo journalctl -b -u docker -u <resolver-service> --no-pager
```

Ожидается отсутствие зависимости Docker от lookup target, который поставляет
guarded resolver, и отсутствие `ordering cycle` в текущем boot. Если Docker
vendor unit изменился, обновите шаблон роли минимально, сохраните нужные vendor
семантики и повторите syntax/static checks до deploy. Не заменяйте проблему
случайным drop-in: `After=` добавляется, но не всегда отменяет унаследованные
зависимости.

## OOM и высокая CPU-нагрузка: отдельная ветка

Kernel/cgroup OOM evidence и длительная высокая CPU-нагрузка — серьёзные
capacity signals shared VPS. Они могут усугубить recovery, но сами по себе не
доказывают причину данного managed-egress отказа. Разделяйте выводы:

- boot ordering cycle — причина, если его подтверждают unit graph и журнал
  текущей загрузки;
- OOM — отдельный capacity incident, который требует проверки limits,
  restart-count, `docker stats --no-stream` и host monitor;
- bounded `restart: on-failure` не меняйте на бесконечный restart-loop, пока
  не понятна ресурсная причина.

Host monitoring и Docker resource policy принадлежат `vps_management`;
прикладные пределы OpenClaw — `openclaw_firststeps`. GhostRoute не должен
менять их, чтобы замаскировать падение managed egress.

## Закрытие и профилактика

После восстановления зафиксируйте в санитизированной записи только:

- какие active probes были fail/ok до и после;
- был ли boot-order cycle в текущей загрузке;
- какие unit/role ownership были затронуты;
- прошёл ли post-upgrade gate;
- есть ли отдельный OOM/capacity follow-up.

Не сохраняйте в tracked docs адреса, SNI, UUID, client names, source addresses,
сырые журналы, screenshots консоли или generated profiles. Для соседних
контуров используйте [VPS host runbook](https://github.com/eiler2005/praefectus-ai/blob/main/docs/runbooks/docker-boot-and-oom.md)
и OpenClaw shared-incident contract; они описывают ownership без раскрытия
deployment values.
