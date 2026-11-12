'use strict';
let pending=false,lastProtection=null;
const strictReason=reason=>({
  active:'Чувствительные сайты идут через обязательный шлюз Guard и проверенный маршрут GhostRoute.',
  checking:'Проверяем маршрут. Запросы сайтов пока закрыты.',paused:'Автоматический доступ приостановлен.',
  waiting:'Настраиваем обязательный proxy Chrome. Сайты пока закрыты.',
  conflict:'Другой компонент управляет proxy или приватностью Chrome. Guard сохраняет блокировку и не заменяет чужие настройки.',
  unsupported_proxy:'Текущий proxy требует отдельного согласования. Доступ закрыт.',
  system_proxy:'В macOS настроен proxy или его состояние неизвестно. Доступ закрыт.',
  catalog_mismatch:'Каталоги приложения и расширения различаются. Обновите расширение.',
  route_unavailable:'Нет однозначного домашнего HTTPS-маршрута для чувствительного каталога.',
  route_failed:'Маршрут не прошёл проверку. Доступ закрыт; проверка повторится автоматически.',
  permission_required:'Разрешите proxy и privacy обновлённому расширению.',
  upgrade_required:'Обновите расширение для строгого режима.'
}[reason] || 'Маршрут не подтверждён. Доступ закрыт.');
async function update() {
  try {
    const status = await chrome.runtime.sendMessage({op:'status'});
    if(lastProtection!==null && lastProtection!==status.protection && !pending)document.getElementById('action-state').textContent='';
    lastProtection=status.protection;
    document.getElementById('protection').textContent = !status.connected ? 'Guard не на связи' : status.strict ? (!status.protection && status.strict.ready ? 'Защищено через GhostRoute' : 'Авто GhostRoute · закрыто') : status.protection ? 'Доступ закрыт' : 'Доступ открыт';
    document.getElementById('protection').dataset.state=!status.connected ? 'closed' : !status.protection ? (status.strict?.ready ? 'protected' : 'unguarded') : 'closed';
    document.getElementById('scope').textContent = !status.connected ? 'Приложение завершено или связь потеряна. Нажмите «Запустить Guard»: доступ откроется после подключения и проверки маршрута.' : status.strict ? strictReason(status.strict.reason) : status.protection ? 'Нажмите «Открыть доступ» здесь или в приложении, чтобы снять блокировку.' : 'Чувствительные сайты разрешены в этом профиле. Используются текущая сеть и VPN обычного Chrome.';
    document.getElementById('baseline').textContent=status.strict?.baseline==='external_pac'?'Включена совместимость с внешним proxy. Другие сайты используют сохранённый снимок его правил.':'Обычные сайты — через сеть Mac. Дома действуют правила роутера; блокировка Guard касается чувствительного каталога.';
    document.getElementById('state').textContent = status.connected ? 'Локальный журнал подключён' : 'Журнал недоступен · блокировка работает';
    for(const [id,value,label] of [['count',status.blocked+status.allowed,'Всего запросов'],['allowed',status.allowed,'Разрешено'],['blocked',status.blocked,'Заблокировано']]){
      const metric=document.getElementById(id);metric.textContent=GuardCounts.compact(value);metric.title=GuardCounts.exact(value);metric.dataset.count=String(value);metric.setAttribute('aria-label',label+': '+GuardCounts.exact(value));
    }
    document.getElementById('exact-counts').textContent=`Всего: ${GuardCounts.exact(status.blocked+status.allowed)} · разрешено: ${GuardCounts.exact(status.allowed)} · заблокировано: ${GuardCounts.exact(status.blocked)}`;
    document.getElementById('reporting').textContent = status.reporting ? 'Передача событий включена' : 'Передача событий выключена';
    document.getElementById('version').textContent = 'v'+chrome.runtime.getManifest().version;
    document.getElementById('missed').textContent = status.missed ? 'Часть сигналов не доставлена в Guard. События не сохраняются на диск и не отправляются повторно.' : '';
    document.getElementById('allow').textContent=!status.connected?'Запустить Guard':status.strict?'Возобновить авто':'Открыть доступ';
    document.getElementById('allow').disabled=pending || (status.connected && (status.strict ? status.strict.enabled : !status.protection));
    document.getElementById('deny').disabled=pending || !status.connected || (status.strict ? !status.strict.enabled && status.protection : status.protection);
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
    let status=await update();
    if(allowed && !status?.connected){
      notice.textContent='Запускаем Guard. Доступ пока закрыт…';
      const started=await chrome.runtime.sendMessage({op:'start_guard'});
      if(started?.ok!==true){notice.textContent='Не удалось запустить Guard. Откройте приложение по ссылке ниже; при необходимости повторите установку.';return;}
      for(let attempt=0;attempt<100;attempt++){
        status=await update();
        if(status?.connected)break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
      if(!status?.connected){notice.textContent='Guard запущен, но служба не ответила. Откройте приложение и проверьте сообщение об ошибке.';return;}
    }
    const result=await chrome.runtime.sendMessage({op:'set_access',allowed});
    if(result?.ok!==true)throw new Error();
    for(let attempt=0;attempt<20;attempt++){
      const status=await update();
      if(status?.connected && status.protection===!allowed){notice.textContent=allowed?'Доступ открыт. Обновите ранее заблокированную страницу.':'Блокировка новых запросов включена.';return;}
      await new Promise(resolve=>setTimeout(resolve,75));
    }
    notice.textContent='Изменение ещё не подтверждено. В автоматическом режиме дождитесь проверки маршрута; статус и причина показаны выше.';
  }catch(_){notice.textContent='Нет подтверждения от Guard. Запустите приложение и повторите.';}
  finally{pending=false;await update();}
}
document.getElementById('allow').addEventListener('click',()=>void setAccess(true));
document.getElementById('deny').addEventListener('click',()=>void setAccess(false));
update();setInterval(update,500);
