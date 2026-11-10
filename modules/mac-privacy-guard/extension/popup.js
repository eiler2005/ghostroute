'use strict';
let pending=false,lastProtection=null;
async function update() {
  try {
    const status = await chrome.runtime.sendMessage({op:'status'});
    if(lastProtection!==null && lastProtection!==status.protection && !pending)document.getElementById('action-state').textContent='';
    lastProtection=status.protection;
    document.getElementById('protection').textContent = status.protection ? 'Доступ закрыт' : 'Доступ открыт';
    document.getElementById('protection').classList.toggle('paused',!status.protection);
    document.getElementById('scope').textContent = status.protection ? 'Нажмите «Открыть доступ» здесь или в приложении, чтобы снять блокировку.' : 'Чувствительные сайты разрешены в этом профиле. Используются текущая сеть и VPN обычного Chrome.';
    document.getElementById('state').textContent = status.connected ? 'Локальный журнал подключён' : 'Журнал недоступен · блокировка работает';
    document.getElementById('count').textContent = status.blocked+status.allowed;
    document.getElementById('allowed').textContent = status.allowed;
    document.getElementById('blocked').textContent = status.blocked;
    document.getElementById('reporting').textContent = status.reporting ? 'Передача событий включена' : 'Передача событий выключена';
    document.getElementById('version').textContent = 'v'+chrome.runtime.getManifest().version;
    document.getElementById('missed').textContent = status.missed ? 'Часть сигналов не доставлена в Guard. События не сохраняются на диск и не отправляются повторно.' : '';
    document.getElementById('allow').disabled=pending || !status.connected || !status.protection;
    document.getElementById('deny').disabled=pending || !status.connected || status.protection;
    return status;
  } catch (_) {document.getElementById('state').textContent = 'Проверьте включение расширения';}
}
async function setAccess(allowed){
  if(pending)return;
  pending=true;
  const notice=document.getElementById('action-state');
  notice.textContent='Chrome применяет настройку…';
  document.getElementById('allow').disabled=true;document.getElementById('deny').disabled=true;
  try{
    const result=await chrome.runtime.sendMessage({op:'set_access',allowed});
    if(result?.ok!==true)throw new Error();
    for(let attempt=0;attempt<20;attempt++){
      const status=await update();
      if(status?.connected && status.protection===!allowed){notice.textContent=allowed?'Доступ открыт. Обновите ранее заблокированную страницу.':'Блокировка новых запросов включена.';return;}
      await new Promise(resolve=>setTimeout(resolve,75));
    }
    notice.textContent='Chrome ещё не подтвердил изменение. Проверьте состояние в приложении.';
  }catch(_){notice.textContent='Нет подтверждения от Guard. Запустите приложение и повторите.';}
  finally{pending=false;await update();}
}
document.getElementById('allow').addEventListener('click',()=>void setAccess(true));
document.getElementById('deny').addEventListener('click',()=>void setAccess(false));
update();setInterval(update,500);
