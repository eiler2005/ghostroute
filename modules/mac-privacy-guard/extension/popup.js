'use strict';
async function update() {
  try {
    const status = await chrome.runtime.sendMessage({op:'status'});
    document.getElementById('protection').textContent = status.protection ? 'Блокировка включена' : `Блокировка приостановлена · ${status.pauseRemaining || 0} с`;
    document.getElementById('protection').classList.toggle('paused',!status.protection);
    document.getElementById('scope').textContent = status.protection ? 'Для чувствительных сайтов используйте отдельный Chrome из приложения Guard.' : 'Этот Chrome может использовать обычную сеть Mac. Пауза не включает защищённый маршрут.';
    document.getElementById('state').textContent = status.connected ? 'Локальный журнал подключён' : 'Журнал недоступен · блокировка работает';
    document.getElementById('count').textContent = status.blocked;
    document.getElementById('reporting').textContent = status.reporting ? 'Передача событий включена' : 'Передача событий выключена';
    document.getElementById('version').textContent = 'v'+chrome.runtime.getManifest().version;
    document.getElementById('missed').textContent = status.missed ? 'Часть сигналов не доставлена в Guard. События не сохраняются на диск и не отправляются повторно.' : '';
  } catch (_) {document.getElementById('state').textContent = 'Проверьте включение расширения';}
}
update();setInterval(update,1500);
