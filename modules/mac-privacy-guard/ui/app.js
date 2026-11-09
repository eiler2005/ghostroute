'use strict';
const sessionCredential = location.hash.slice(1) || sessionStorage.getItem('guard-token') || '';
history.replaceState(null, '', '/');
sessionStorage.setItem('guard-token', sessionCredential);
const $ = (id) => document.getElementById(id);
let routeSignature = '';
async function api(path, payload) {
  const response = await fetch('/api/' + path, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {Authorization: 'Bearer ' + sessionCredential, 'Content-Type': 'application/json'},
    ...(payload === undefined ? {} : {body: JSON.stringify(payload)})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Локальное приложение недоступно');
  return data;
}
function render(data) {
  $('state').textContent = {locked: 'ЗАКРЫТО', qualifying: 'ПРОВЕРКА', active: 'ДОСТУП ОТКРЫТ'}[data.state];
  $('state').dataset.mode = data.state;
  $('message').textContent = data.message;
  $('browse').disabled = data.state !== 'active';
  $('counts').textContent = `Чувствительных доменов: ${data.sensitive_domains} · Соединений разрешено: ${data.allowed} · Отказов: ${data.blocked}`;
  $('empty').hidden = data.routes.length !== 0;
  const signature = JSON.stringify([data.routes, data.route, data.state]);
  if (signature !== routeSignature) {
    routeSignature = signature;
    $('routes').replaceChildren(...data.routes.map(route => {
      const button = document.createElement('button');
      button.className = 'route';
      const title = document.createElement('strong');
      title.textContent = route.id;
      const detail = document.createElement('span');
      detail.textContent = route.kind === 'https_proxy' ? `Домашний HTTPS · ${route.domains} доменов` : 'VPN · привязка к интерфейсу';
      button.append(title, detail);
      button.disabled = data.state === 'qualifying';
      button.dataset.selected = route.id === data.route;
      button.onclick = () => action('activate', {route: route.id});
      return button;
    }));
  }
}
async function action(path, payload) {
  $('error').textContent = '';
  try { render(await api(path, payload)); } catch (error) { $('error').textContent = error.message; }
}
$('lock').onclick = () => action('lock', {});
$('open').onsubmit = event => {event.preventDefault(); action('open', {url: $('url').value});};
$('profile').onchange = async () => {
  const file = $('profile').files[0];
  try {
    if (!file || file.size > 131072) throw new Error('Профиль слишком большой');
    await action('profile', {profile: JSON.parse(await file.text())});
  } catch (_) { $('error').textContent = 'Не удалось прочитать JSON-профиль'; }
  $('profile').value = '';
};
async function refresh() {
  try { render(await api('status')); }
  catch (_) { $('state').textContent = 'НЕТ СВЯЗИ'; $('message').textContent = 'Шлюз недоступен. Прямого резервного выхода в защищённом браузере нет.'; $('browse').disabled = true; }
}
refresh(); setInterval(refresh, 1500);
