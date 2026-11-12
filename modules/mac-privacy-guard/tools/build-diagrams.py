#!/usr/bin/env python3
"""Build public, editable RU/EN documentation figures; no deployment inputs."""
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEST = ROOT / 'docs/assets/diagrams'
STYLE = '''
*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#0b172a;font-family:Arial,Helvetica,sans-serif}
main{max-width:1360px;margin:auto;padding:32px}h1{font-size:32px;line-height:1.2}h2{font-size:25px}p{max-width:1040px;line-height:1.65}a{color:#1d4ed8}section{margin:40px 0 56px}
.diagram-container{overflow-x:auto;border:1px solid #cbd5e1;border-radius:12px;max-width:100%}svg{display:block;width:1280px;min-width:1280px;height:auto}svg text{font-family:Arial,Helvetica,sans-serif;fill:#0b172a}
.paper{fill:#fff}.zone{fill:#f8fbff;stroke:#dbe5f1}.eyebrow{font-size:13px;font-weight:600;letter-spacing:1.6px;fill:#475569}.heading{font-size:36px;font-weight:700}.subtitle{font-size:18px;fill:#475569}
.node>rect{fill:#fff;stroke:#94a3b8;stroke-width:1.5}.node.focal>rect{fill:#eff6ff;stroke:#1d4ed8;stroke-width:2}.node-name{font-size:23px;font-weight:600}.body{font-size:18px;fill:#334155}.mono{font-family:Menlo,Consolas,monospace;font-size:15px;fill:#475569}.tag{font-size:12px;letter-spacing:1px;font-weight:600;fill:#475569}
.edge{fill:none;stroke:#475569;stroke-width:2}.edge.control{stroke-dasharray:6 5}.edge.focal{stroke:#1d4ed8}.edge-label rect{fill:#fff}.edge-label text{font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:600;fill:#475569;letter-spacing:.5px}.legend{font-size:16px;fill:#475569}.fine{font-size:15px;fill:#475569}.rule{stroke:#cbd5e1}.caption{color:#475569}
@media(max-width:600px){main{padding:16px}h1{font-size:27px}}
@media print{main{max-width:none;padding:0}.diagram-container{overflow:visible;border:0}svg{min-width:0;width:100%;height:auto}section{break-inside:avoid}}
'''


def node(key, x, y, w, h, title, lines, tag='', focal=False):
    body = f'<g class="node{" focal" if focal else ""}" data-node="{key}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8"/>'
    if tag:
        body += f'<text x="{x+24}" y="{y+24}" class="tag">{escape(tag)}</text>'
    baseline = y + (56 if tag else 36)
    body += f'<text x="{x+24}" y="{baseline}" class="node-name">{escape(title)}</text>'
    for index, line in enumerate(lines):
        body += f'<text x="{x+24}" y="{baseline+30+index*26}" class="body">{escape(line)}</text>'
    return body + '</g>'


def edge(source, target, path, kind='', label=None):
    body = f'<path class="edge {kind}" data-from="{source}" data-to="{target}" d="{path}" marker-end="url(#ARROW)"/>'
    if label:
        x,y,width,text = label
        body += f'<g class="edge-label"><rect x="{x}" y="{y}" width="{width}" height="24" rx="3"/><text x="{x+width/2}" y="{y+17}" text-anchor="middle">{escape(text)}</text></g>'
    return body


def figure(lang, kind, title, subtitle, content, legend, fine, caption):
    slug=f'ghostroute-guard-{kind}-{lang}'
    content=content.replace('ARROW',slug+'-arrow')
    desc = ('Схематический контракт Guard без приватных данных развёртывания: ' if lang=='ru' else 'Guard behavior without private deployment data: ') + subtitle
    return f'''<section id="{kind}"><h2>{escape(title)}</h2><div class="diagram-container">
<svg id="{slug}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" role="img" aria-labelledby="{slug}-title {slug}-desc">
<title id="{slug}-title">{escape(title)}</title><desc id="{slug}-desc">{escape(desc)}</desc>
<defs><marker id="{slug}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10Z" fill="#475569"/></marker></defs>
<rect class="paper" width="1280" height="720"/>
<text x="48" y="44" class="eyebrow">GHOSTROUTE GUARD / {kind.upper()}</text>
<text x="48" y="92" class="heading">{escape(title)}</text><text x="48" y="130" class="subtitle">{escape(subtitle)}</text>
{content}
<line class="rule" x1="48" y1="648" x2="1232" y2="648"/>
<text class="legend" x="48" y="678">{escape(legend)}</text><text class="fine" x="48" y="704">{escape(fine)}</text>
</svg></div><p class="caption">{escape(caption)}</p></section>'''


def routing(ru):
    nodes = [
      node('chrome',64,228,224,104,'Chrome',['Обычный профиль' if ru else 'Your existing profile']),
      node('policy',352,216,336,128,'Политика каталога' if ru else 'Catalog policy',['PAC + DNR','Чувствительные адреса — первыми' if ru else 'Sensitive destinations first'],focal=True),
      node('external',864,216,352,128,'Другие назначения' if ru else 'Other destinations',['Сеть Mac → роутер' if ru else 'Mac network → home router','Его managed/direct правила' if ru else 'Existing managed/direct rules']),
      node('closed',64,416,224,128,'Доступ закрыт' if ru else 'Access blocked',['Нет подтверждения' if ru else 'No valid proof','или ручная пауза' if ru else 'or a manual pause']),
      node('gate',352,416,336,128,'Шлюз Guard' if ru else 'Guard gateway',['Изолирован на агент Chrome' if ru else 'Isolated per Chrome agent','Без прямого fallback' if ru else 'No direct fallback'],focal=True),
      node('route',864,416,352,128,'Маршрут GhostRoute' if ru else 'GhostRoute path',['Домашний HTTPS → policy' if ru else 'Home HTTPS → reviewed policy','sensitive-out → hermes_vps']),
    ]
    paths=[edge('chrome','policy','M288 280 H352'),
      edge('policy','external','M688 248 H864',label=(732,216,88,'ПРОЧЕЕ' if ru else 'OTHER')),
      edge('policy','gate','M432 344 V416','focal',label=(440,364,136,'КАТАЛОГ' if ru else 'CATALOG')),
      edge('policy','closed','M352 320 H328 Q320 320 320 328 V384 Q320 392 312 392 H184 Q176 392 176 400 V416','control'),
      edge('gate','route','M688 480 H864','focal',label=(712,448,128,'ПРОВЕРЕНО' if ru else 'VERIFIED'))]
    return ''.join(paths+nodes)


def components(ru):
    nodes=[node('ui',64,216,288,112,'Нативное окно' if ru else 'Native window',['SwiftUI / AppKit','Команды и состояние' if ru else 'Commands and state']),
      node('engine',496,216,288,112,'Локальный engine' if ru else 'Local engine',['Qualification · gates','Приватный loopback API' if ru else 'Private loopback API'],focal=True),
      node('extension',928,216,288,112,'Расширение Chrome' if ru else 'Chrome extension',['PAC · privacy · DNR','Popup + scoped DevTools']),
      node('journal',64,416,288,112,'Журнал в памяти' if ru else 'Memory journal',['До 300 событий' if ru else 'Up to 300 events','Без URL, headers и cookies' if ru else 'No full URLs or cookies']),
      node('profile',496,416,288,112,'Приватный профиль' if ru else 'Private profile',['TLS trust · approved exit','Allowlist + credentials']),
      node('host',928,416,288,112,'Native host',['Фиксированные сообщения' if ru else 'Fixed message schemas','Без API token в Chrome' if ru else 'No API token in Chrome'])]
    paths=[edge('ui','engine','M352 256 H496','control'),edge('engine','ui','M496 288 H352','control'),
      edge('engine','host','M784 296 H848 Q856 296 856 304 V464 Q856 472 864 472 H928','control'),
      edge('host','engine','M928 440 H896 Q888 440 888 432 V256 Q888 248 880 248 H784','control'),
      edge('extension','host','M1040 328 V416','control'),edge('host','extension','M1104 416 V328','control'),
      edge('profile','engine','M640 416 V328','control'),
      edge('engine','journal','M496 312 H408 Q400 312 400 320 V464 Q400 472 392 472 H352','control')]
    return ''.join(paths+nodes)


def states(ru):
    nodes=[node('blocked',64,220,240,120,'Закрыто' if ru else 'Blocked',['Нет допуска к каталогу' if ru else 'Catalog not admitted','Запуск или отказ' if ru else 'Startup or failure']),
      node('checking',400,220,272,120,'Проверка' if ru else 'Checking',['TLS · exit · catalog','Proxy / privacy ownership']),
      node('active',928,220,288,120,'Доступ защищён' if ru else 'Protected access',['Только через Guard' if ru else 'Through Guard only','Обновление проверки' if ru else 'Proof renewed periodically'],focal=True),
      node('paused',928,464,288,112,'Ручная пауза' if ru else 'Manual pause',['Каталог и туннели закрыты' if ru else 'Catalog and tunnels closed','До Resume / перезапуска' if ru else 'Until Resume or a new run'])]
    paths=[edge('blocked','checking','M304 280 H400',label=(312,248,80,'АВТО' if ru else 'AUTO')),
      edge('checking','active','M672 280 H928','focal',label=(712,248,168,'ПРОВЕРЕНО' if ru else 'VERIFIED')),
      edge('checking','blocked','M496 220 V192 Q496 184 488 184 H192 Q184 184 184 192 V220','control',label=(288,152,104,'ОТКАЗ' if ru else 'FAIL')),
      edge('active','paused','M1104 340 V464',label=(1112,384,96,'ЗАКРЫТЬ' if ru else 'CLOSE')),
      edge('paused','checking','M928 520 H840 Q832 520 832 512 V388 Q832 380 824 380 H568 Q560 380 560 372 V340',label=(840,488,80,'RESUME')),
      edge('active','blocked','M984 340 V412 Q984 420 976 420 H840 a8 8 0 0 0 -16 0 H184 Q176 420 176 412 V340','control',label=(432,428,240,'ОТКАЗ / EXPIRY' if ru else 'FAIL / STALE'))]
    return ''.join(paths+nodes)


for lang in ('ru','en'):
    ru=lang=='ru'
    title='GhostRoute Guard — визуальное руководство' if ru else 'GhostRoute Guard — visual guide'
    figures=[figure(lang,'routing','Два пути в одном Chrome' if ru else 'Two paths in one Chrome',
      'Чувствительные сайты — через Guard; обычные — по сетевым правилам Mac и роутера.' if ru else 'Sensitive sites require Guard; ordinary sites follow the Mac network and router rules.',routing(ru),
      'Сплошная — путь запроса. Пунктир — закрытие доступа до допуска.' if ru else 'Solid: request path. Dashed: rejection before admission.',
      'Внешний PAC — отдельная опция. Пауза и отказ Guard закрывают только чувствительный каталог.' if ru else 'External PAC is opt-in. Guard pause or failure closes only the sensitive destination catalog.',
      'Детали роутера объединены в проверенный маршрут. Неизвестные CDN/IP/TURN TCP вне каталога используют обычный путь.' if ru else 'Router detail is collapsed into the qualified path. Unknown CDN/IP/TURN TCP outside the catalog use the ordinary path.'),
      figure(lang,'components','Приложение управляет, Chrome исполняет' if ru else 'The app controls; Chrome enforces',
      'Контрольный контур локален; поток HTTPS проходит через отдельный gate.' if ru else 'The control plane stays local; HTTPS traffic uses a separate gateway.',components(ru),
      'Пунктир — команды, события и чтение состояния. Это не маршрут пакетов.' if ru else 'Dashed: commands, events and state reads. These are not packet paths.',
      'HTTP-диагностика — только подготовленная вкладка. Дополнительный браузер имеет отдельный gate.' if ru else 'HTTP diagnostics require a prepared tab. The optional browser has its own gateway.',
      'API token остаётся в нативном клиенте. Исходный внешний PAC хранится только в настройках Chrome. Общий журнал не содержит HTTP-тел.' if ru else 'The API token stays in the native client. External PAC source stays in Chrome settings. The shared journal contains no HTTP bodies.'),
      figure(lang,'states','Доступ открывается после проверки' if ru else 'Access follows successful verification',
      'Закрытие отменяет допуск; поздний успех старой проверки не возвращает доступ.' if ru else 'Close revokes admission; late success from an old check cannot reopen access.',states(ru),
      'Стрелки — переходы. Пунктир — возврат при отказе или устаревшей проверке.' if ru else 'Arrows: transitions. Dashed: failure or stale-proof recovery.',
      'Проверка ≈ 5 с; срок доказательства ≤ 10 с. Удалённая проверка не имеет SLA в две секунды.' if ru else 'Recheck ≈ 5 s; proof expires after 10 s. Remote verification has no two-second SLA.',
      'При паузе и потере engine owned PAC/privacy остаются на закрытом gate. Новый запуск начинает автоматическую проверку; ручная пауза не хранится на диске.' if ru else 'On pause or engine loss, owned PAC/privacy remain on a closed gateway. A new engine run restarts automatic verification; manual pause is not stored on disk.')]
    intro='Реализованный контракт без приватных адресов, провайдеров и снимков трафика.' if ru else 'Implemented contracts without private addresses, providers or traffic snapshots.'
    nav=f'<a href="ghostroute-guard-{"en" if ru else "ru"}.html">{"English" if ru else "Русский"}</a> · <a href="../../../modules/mac-privacy-guard/docs/user-guide.md">User guide</a> · <a href="../../../modules/mac-privacy-guard/tests/README.md">Tests</a>'
    page=f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title><style>{STYLE}</style></head><body><main><nav>{nav}</nav><h1>{title}</h1><p>{intro}</p>{"".join(figures)}</main></body></html>'
    (DEST/f'ghostroute-guard-{lang}.html').write_text(page)
print('Built RU/EN routing, component and lifecycle diagram sources')
