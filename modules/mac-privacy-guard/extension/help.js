'use strict';
async function update(){
  try{const state=await chrome.runtime.sendMessage({op:'status'});document.getElementById('state').textContent=(state.connected?'Приложение на связи. ':'Приложение недоступно. ')+(state.protection?'Блокировка включена.':`Пауза блокировки: до ${state.pauseRemaining || 0} с.`);}
  catch(_){document.getElementById('state').textContent='Проверьте включение расширения и перезагрузите эту страницу.';}
}update();setInterval(update,2000);
