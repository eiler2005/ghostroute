'use strict';
async function update() {
  try {
    const status = await chrome.runtime.sendMessage({op:'status'});
    document.getElementById('protection').textContent = status.protection ? 'Доступ закрыт' : 'Доступ открыт';
    document.getElementById('protection').classList.toggle('paused',!status.protection);
    document.getElementById('scope').textContent = status.protection ? 'Нажмите «Открыть доступ в Chrome» в приложении, чтобы снять блокировку.' : 'Чувствительные сайты разрешены в этом профиле. Используются текущая сеть и VPN обычного Chrome.';
    document.getElementById('state').textContent = status.connected ? 'Локальный журнал подключён' : 'Журнал недоступен · блокировка работает';
    document.getElementById('count').textContent = status.blocked+status.allowed;
    document.getElementById('allowed').textContent = status.allowed;
    document.getElementById('blocked').textContent = status.blocked;
    document.getElementById('reporting').textContent = status.reporting ? 'Передача событий включена' : 'Передача событий выключена';
    document.getElementById('version').textContent = 'v'+chrome.runtime.getManifest().version;
    document.getElementById('missed').textContent = status.missed ? 'Часть сигналов не доставлена в Guard. События не сохраняются на диск и не отправляются повторно.' : '';
  } catch (_) {document.getElementById('state').textContent = 'Проверьте включение расширения';}
}
update();setInterval(update,1500);
