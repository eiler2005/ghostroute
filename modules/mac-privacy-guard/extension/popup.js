'use strict';
async function update() {
  try {
    const status = await chrome.runtime.sendMessage({op:'status'});
    document.getElementById('state').textContent = status.connected ? 'Локальный журнал подключён' : 'Журнал недоступен · блокировка работает';
    document.getElementById('count').textContent = status.blocked;
    document.getElementById('missed').textContent = status.missed ? 'Часть сигналов не доставлена в Guard. События не сохраняются на диск и не отправляются повторно.' : '';
  } catch (_) {document.getElementById('state').textContent = 'Проверьте включение расширения';}
}
update();setInterval(update,1500);
