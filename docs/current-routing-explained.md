# Current Routing Explained

## Что уже сделано

На роутере уже работает выборочная отправка трафика через `WireGuard WGC1`.

Схема такая:

1. Устройство в сети открывает сайт.
2. `dnsmasq` на роутере видит DNS-запрос.
3. Если домен входит в наши правила, его IP попадает в `VPN_DOMAINS`.
4. `iptables` помечает трафик к этим IP.
5. `ip rule` отправляет помеченные пакеты в таблицу `wgc1`.
6. Трафик уходит через WireGuard.

Отдельно для Telegram добавлен ещё один набор: `VPN_STATIC_NETS`.
Он нужен потому, что Telegram часто использует не только домены, но и собственные IP-подсети.

Для всех доменных семейств, которые мы ведём через VPN, добавлен ещё и отдельный upstream DNS через `WireGuard`.
Это нужно потому, что обычные DNS провайдера могут отдавать локализованные российские CDN/IP-адреса, даже когда сам трафик уже должен идти через managed VPN path.
Именно на TikTok эта проблема проявилась первой, но логика актуальна и для других сервисов.
Отдельно выяснилось, что DNS самого VPN-провайдера `10.254.254.254` часть доменов резолвит нестабильно, поэтому для VPN-доменов используется пара публичных резолверов `1.1.1.1` и `9.9.9.9`.
Чтобы эти запросы не ушли через обычный WAN, на роутере добавлены отдельные `ip rule` и они тоже принудительно отправляются в таблицу `wgc1`.

## Что сейчас идёт через VPN

Через VPN сейчас направляются такие доменные семейства:

- `atlassian.com`
- `anthropic.com`
- `aistudio.google.com`
- `chatgpt.com`
- `claude.ai`
- `claude.com`
- `ai.google.dev`
- `generativelanguage.googleapis.com`
- `github.com`
- `api.github.com`
- `githubstatus.com`
- `raw.githubusercontent.com`
- `objects.githubusercontent.com`
- `githubusercontent.com`
- `codeload.github.com`
- `gitlab.com`
- `gitlab-static.net`
- `bitbucket.org`
- `dev.azure.com`
- `visualstudio.com`
- `google.com`
- `linkedin.com`
- `twitter.com`
- `x.com`
- `twimg.com`
- `t.co`
- `notebooklm.google.com`
- `tiktok.com`
- `tiktokv.com`
- `tiktokcdn.com`
- `tiktokcdn-us.com`
- `tiktokcdn-eu.com`
- `byteoversea.com`
- `ibytedtos.com`
- `byteimg.com`
- `muscdn.com`
- `ttwstatic.com`
- `youtube.com`
- `youtu.be`
- `googlevideo.com`
- `ytimg.com`
- `ggpht.com`
- `youtubei.googleapis.com`
- `telegram.org`
- `t.me`
- `telegram.me`
- `telegra.ph`
- `telesco.pe`
- `cdn-telegram.org`
- `telegram-cdn.org`
- `tg.dev`
- `instagram.com`
- `cdninstagram.com`
- `fbcdn.net`
- `fbsbx.com`
- `openai.com`
- `oaistatic.com`
- `oaiusercontent.com`
- `redshieldvpn.com`
- `whatsapp.com`
- `whatsapp.net`
- `wa.me`

Плюс для Telegram дополнительно используются статические IPv4-подсети из `configs/static-networks.txt`.

## Как понимать правила dnsmasq

Строка такого вида:

```text
ipset=/youtube.com/VPN_DOMAINS
```

не означает только один домен `youtube.com`.
Она означает:

- `youtube.com`
- и любые поддомены вида `*.youtube.com`

То есть правило покрывает не один хост, а всё семейство домена.

Поэтому вручную перечислять все возможные поддомены обычно не нужно.
Если сервис завтра создаст новый поддомен внутри того же доменного суффикса, правило его тоже поймает.

## Что покрывает каждая строка

Ниже не “полный список всех когда-либо существовавших хостов”, а именно смысл каждого суффиксного правила.

### Atlassian

- `atlassian.com`
- примеры: `www.atlassian.com`, `id.atlassian.com`, `admin.atlassian.com`, `support.atlassian.com`

### Anthropic / Claude Code

- `anthropic.com`
- примеры: `api.anthropic.com`, `console.anthropic.com`, будущие `*.anthropic.com`
- `claude.ai`
  доменное семейство Claude web и связанных хостов `*.claude.ai`

### Google AI Studio / NotebookLM / Gemini API

- `aistudio.google.com`
  web-интерфейс Google AI Studio
- `notebooklm.google.com`
  web-интерфейс NotebookLM
- `ai.google.dev`
  документация и web-интерфейсы Google AI Developers
- `generativelanguage.googleapis.com`
  Gemini API endpoint
- `google.com`
  вход, сессии и связанные `*.google.com` поддомены

### GitHub / GitHub CLI

- `github.com`
  основной web, device-flow login и HTTPS git-операции
- `api.github.com`
  API-вызовы GitHub CLI, проверка пользователя и служебные запросы
- `githubstatus.com`
  status page, на которую GitHub CLI ссылается в диагностике проблем
- `raw.githubusercontent.com`
  raw-файлы и bootstrap-скрипты
- `objects.githubusercontent.com`
  release assets и объекты GitHub
- `githubusercontent.com`
  широкий домен для пользовательского и служебного GitHub-контента
- `codeload.github.com`
  архивы репозиториев и исходников

### GitLab / Bitbucket / Azure DevOps

- `gitlab.com`
  web, auth, HTTPS git-операции и `altssh.gitlab.com`
- `gitlab-static.net`
  статические ресурсы GitLab web
- `bitbucket.org`
  Bitbucket Cloud web, API-поддомены и alt SSH-поддомены
- `dev.azure.com`
  Azure DevOps repos и SSH/HTTPS git endpoints
- `visualstudio.com`
  legacy Azure DevOps / Visual Studio Team Services URLs

### ChatGPT

- `chatgpt.com`
- примеры: `chatgpt.com`, `www.chatgpt.com`, любые будущие `*.chatgpt.com`

### Claude

- `claude.com`
- примеры: `claude.com`, `www.claude.com`, любые будущие `*.claude.com`

### Google

- `google.com`
- примеры: `www.google.com`, `accounts.google.com`, `mail.google.com`, `drive.google.com`

### LinkedIn

- `linkedin.com`
- примеры: `www.linkedin.com`, `static.linkedin.com`, `media.linkedin.com`

### Twitter / X

- `twitter.com`
- примеры: `twitter.com`, `www.twitter.com`, `mobile.twitter.com`
- `x.com`
  новый основной домен X/Twitter и связанные `*.x.com` хосты
- `twimg.com`
  статика, скрипты, картинки и видео-хосты X/Twitter (`abs.twimg.com`, `pbs.twimg.com`, `video.twimg.com`)
- `t.co`
  короткие ссылки и redirect-домен X/Twitter

### TikTok и связанные домены

- `tiktok.com`
  основной сайт и web-входы TikTok
- `tiktokv.com`
  media и app/service endpoints TikTok
- `tiktokcdn.com`
  CDN-домены TikTok
- `tiktokcdn-us.com`
  CDN-домены TikTok для US/глобальных узлов
- `tiktokcdn-eu.com`
  CDN-домены TikTok для EU-узлов
- `byteoversea.com`
  связанные ByteDance/TikTok сервисные домены
- `ibytedtos.com`
  object storage и media/service endpoints ByteDance
- `byteimg.com`
  изображения и статические ресурсы ByteDance/TikTok
- `muscdn.com`
  media/CDN-домены, которые часто встречаются у TikTok-экосистемы
- `ttwstatic.com`
  дополнительные статические ресурсы TikTok web/app

Важно:
для TikTok, как и для YouTube, одного домена обычно недостаточно.
Нужны соседние CDN и service families.

Дополнительно:
для всех VPN-доменов настроен отдельный DNS upstream через `1.1.1.1@wgc1` и `9.9.9.9@wgc1`, а также отдельные `ip rule` для самих DNS-резолверов, чтобы резолв не шёл через локальные DNS провайдера и не зависел от неполного DNS VPN-провайдера.

Технически это хранится так:

- в проекте upstream-правила лежат отдельно в `configs/dnsmasq-vpn-upstream.conf.add`
- при деплое они встраиваются в `/jffs/configs/dnsmasq.conf.add`

Это сделано потому, что на Merlin в рабочий конфиг `dnsmasq` автоматически попадает именно `dnsmasq.conf.add`.

Практический смысл такой:

- сайт из VPN-списка не только уходит через `WGC1`
- его DNS-ответ тоже приходит не от локального RU-DNS провайдера
- это уменьшает шанс, что сервис даст российский CDN или российскую географию выдачи

### YouTube и связанные домены

- `youtube.com`
  примеры: `www.youtube.com`, `m.youtube.com`, `studio.youtube.com`, `music.youtube.com`
- `youtu.be`
  короткие ссылки YouTube
- `googlevideo.com`
  видеостримы и media endpoints YouTube
- `ytimg.com`
  картинки, превью, статические ресурсы YouTube
- `ggpht.com`
  изображения и media-хосты Google/YouTube
- `youtubei.googleapis.com`
  API-вызовы YouTube-клиентов

Важно:
для YouTube не существует маленького “одного домена”.
Нужны именно доменные семейства и связанные CDN-домены, поэтому список шире.

### Telegram

Telegram — самый сложный сервис для маршрутизации, потому что использует и домены, и прямые IP-подключения. Подробный разбор: [telegram-deep-dive.md](telegram-deep-dive.md).

**Core:**

- `telegram.org`
  примеры: `telegram.org`, `web.telegram.org`, `desktop.telegram.org`, `api.telegram.org`
- `telegram.com`
  альтернативный домен (редирект на telegram.org)
- `t.me`
  короткие ссылки Telegram
- `telegram.me`
  старый короткий домен Telegram, который всё ещё встречается
- `telegra.ph`
  Telegraph / статьи и часть Telegram-ссылок на контент
- `telesco.pe`
  web-представление некоторых публичных Telegram media links
- `tg.dev`
  технические и служебные хосты Telegram

**CDN:**

- `cdn-telegram.org`
  media/CDN-хосты Telegram, которые встречаются у публичных файлов и web media links
- `telegram-cdn.org`
  соседнее Telegram CDN-семейство для media-хостов и прямых файловых ссылок

**Экосистема:**

- `fragment.com`
  маркетплейс юзернеймов и номеров Telegram
- `graph.org`
  альтернативный домен Telegraph
- `contest.com`
  платформа конкурсов Telegram
- `comments.app`
  виджет комментариев для каналов
- `usercontent.dev`
  доставка пользовательского контента
- `tdesktop.com`
  домен Telegram Desktop

Важно:
для Telegram одних доменов часто недостаточно.
Поэтому дополнительно добавлены статические IPv4-подсети: официальные из `core.telegram.org/resources/cidr.txt`, AS62041 peering/CDN-подсети для медиа-доставки в России, и несколько legacy/observed подсетей.

### Instagram

- `instagram.com`
- примеры: `www.instagram.com`, `i.instagram.com`, `help.instagram.com`
- `cdninstagram.com`
  CDN и media-хосты Instagram
- `fbcdn.net`
  видео, изображения и CDN-хосты Meta/Instagram
- `fbsbx.com`
  вспомогательные file/media endpoints Meta

### OpenAI / ChatGPT assets

- `openai.com`
  примеры: `openai.com`, `auth.openai.com`, `platform.openai.com`
- `oaistatic.com`
  статические ресурсы OpenAI
- `oaiusercontent.com`
  пользовательский и служебный контент OpenAI

### RedShield VPN

- `redshieldvpn.com`
  сайт VPN-провайдера: личный кабинет, конфигурации, поддержка

### WhatsApp

- `whatsapp.com`
  примеры: `whatsapp.com`, `web.whatsapp.com`, `faq.whatsapp.com`
- `whatsapp.net`
  серверы мессенджера и media CDN: `mmg.whatsapp.net`, `scdn.whatsapp.net`, `media-*.whatsapp.net`
- `wa.me`
  короткие ссылки для контактов и чатов

Примечание:
Media-контент WhatsApp (изображения, видео, документы) отдаётся через `fbcdn.net` и `fbsbx.com`,
которые уже добавлены в конфиг как часть семейства Instagram / Meta CDN.

## Чего это не покрывает автоматически

Правило по домену не покрывает соседний домен другого суффикса.

Например:

- `youtube.com` не покрывает `googlevideo.com`
- `chatgpt.com` не покрывает `openai.com`
- `telegram.org` не покрывает прямые Telegram IP-подсети

Поэтому для некоторых сервисов нужен набор из нескольких доменных семейств, а иногда и статические сети.

## Почему это всё равно нормально

Идея не в том, чтобы собрать “все IP навсегда”.
Идея в том, чтобы покрыть нужные доменные семейства.
IP-адреса внутри этих семейств может менять сам сервис, а `dnsmasq` будет заново добавлять их в `ipset`.

## Автоматическое обнаружение доменов

Список ручных доменов выше дополняется автоматически обнаруженными.

Скрипт `domain-auto-add.sh` запускается каждые 4 часа через cron — парсит DNS-лог dnsmasq, фильтрует системные домены и российские TLD, добавляет новые в `/jffs/configs/dnsmasq-autodiscovered.conf.add`.

Авто-добавленные домены не хранятся в git, но работают наравне с ручными.

Просмотр:
```bash
./scripts/domain-report --all   # все авто-добавленные домены
./scripts/domain-report --log   # лог активности
```

Для ручного анализа конкретного сервиса доступны утилиты `getdomainnames.sh` и `autoscan` из x3mRouting. Routing-функции x3mRouting не используются (заточены под OpenVPN).

Подробности: [x3mrouting-roadmap.md](x3mrouting-roadmap.md).

## Связанные документы

- [architecture.md](architecture.md) — как устроена маршрутизация на системном уровне
- [domain-management.md](domain-management.md) — как добавлять и удалять домены
- [telegram-deep-dive.md](telegram-deep-dive.md) — подробности по Telegram (подсети, DPI, CDN)
