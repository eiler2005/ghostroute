'use strict';
async function update(){
  try{const state=await chrome.runtime.sendMessage({op:'status'});document.getElementById('state').textContent=(state.connected?'Приложение на связи. ':'Приложение недоступно. ')+(state.protection?'Доступ в Chrome закрыт.':'Доступ в Chrome открыт.');}
  catch(_){document.getElementById('state').textContent='Проверьте включение расширения и перезагрузите эту страницу.';}
}update();setInterval(update,2000);
