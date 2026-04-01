# AI Tooling Domains

## Зачем нужен этот документ

Здесь собраны доменные семейства для инструментов разработки и AI-сервисов, которые имеет смысл отправлять через VPN в вашем рабочем сценарии.

## Уже включено в конфиг

Все перечисленные ниже домены не только маршрутизируются через `WGC1`, но и резолвятся через публичные DNS `1.1.1.1` и `9.9.9.9`, отправленные через `wgc1`. Это уменьшает риск, что сервис получит локализованные ответы от DNS провайдера.

### GitHub / GitHub CLI

- `github.com`
- `api.github.com`
- `githubstatus.com`
- `raw.githubusercontent.com`
- `objects.githubusercontent.com`
- `githubusercontent.com`
- `codeload.github.com`

Что это покрывает:

- browser device-flow через `https://github.com/login/device`
- OAuth endpoints `https://github.com/login/oauth/*`
- GitHub CLI проверки аккаунта и API-вызовы через `api.github.com`
- HTTPS git-операции к `github.com`
- status page `githubstatus.com`, которая фигурирует в ошибках GitHub CLI
- raw-файлы, release assets и архивы репозиториев

### GitLab / Bitbucket / Azure DevOps

- `gitlab.com`
- `gitlab-static.net`
- `bitbucket.org`
- `dev.azure.com`
- `visualstudio.com`

Что это покрывает:

- GitLab web и git-операции
- GitLab static assets для web UI
- Bitbucket Cloud web и git-операции
- Azure DevOps repos и legacy Visual Studio Team Services URLs

### OpenAI / Codex / ChatGPT

- `chatgpt.com`
- `openai.com`
- `oaistatic.com`
- `oaiusercontent.com`

Что это покрывает:

- ChatGPT web
- OpenAI auth
- OpenAI platform и API-соседние хосты под `*.openai.com`
- статические и контентные домены OpenAI

### Anthropic / Claude / Claude Code

- `anthropic.com`
- `claude.ai`
- `claude.com`

Что это покрывает:

- `api.anthropic.com`
- `console.anthropic.com`
- `claude.ai`
- `claude.com`
- связанные поддомены `*.anthropic.com`, `*.claude.ai`, `*.claude.com`

### Google AI Studio / NotebookLM / Gemini API

- `aistudio.google.com`
- `notebooklm.google.com`
- `ai.google.dev`
- `generativelanguage.googleapis.com`
- `google.com`

Что это покрывает:

- Google AI Studio web
- NotebookLM web
- документацию и web-хосты Google AI Developers
- Gemini API через `generativelanguage.googleapis.com`
- Google sign-in и связанные `*.google.com` поддомены

Важно:

- `aistudio.google.com` и `notebooklm.google.com` уже попадают под правило `google.com`, но записаны отдельно для читаемости.
- `generativelanguage.googleapis.com` добавлен отдельно, потому что `google.com` не покрывает `googleapis.com`.

## Уже включено для смежных сервисов

- `google.com`
- `youtube.com`
- `youtu.be`
- `googlevideo.com`
- `ytimg.com`
- `ggpht.com`
- `youtubei.googleapis.com`

Это полезно, если AI-сервисы используют Google sign-in, Google-hosted media, YouTube-ссылки или встроенные preview.

## Что пока не включено

Ниже кандидаты, которые можно добавить позже, если появится реальная проблема:

### VS Code / Marketplace

- `marketplace.visualstudio.com`
- `gallery.vsassets.io`
- `gallerycdn.vsassets.io`
- `update.code.visualstudio.com`
- `vscode.dev`

## Рекомендуемый минимальный набор для вашей работы

Если смотреть именно на ваш текущий стек `VS Code + Codex/OpenAI + Claude Code + Google AI tools`, то уже включённый минимум выглядит так:

- `chatgpt.com`
- `openai.com`
- `oaistatic.com`
- `oaiusercontent.com`
- `anthropic.com`
- `claude.ai`
- `claude.com`
- `aistudio.google.com`
- `notebooklm.google.com`
- `ai.google.dev`
- `generativelanguage.googleapis.com`
- `google.com`
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

## Когда имеет смысл что-то добавлять ещё

Добавлять новый домен имеет смысл только если:

1. Сервис открывается частично, но не работает полностью.
2. На роутере видно, что нужные хосты не попали в `VPN_DOMAINS`.
3. Домен относится к тому же сервису, а не является слишком широким “общим интернетом”.
