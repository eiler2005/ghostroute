'use strict';
window.mountGuard=controller=>{
  const $=id=>document.getElementById(id);
  const render=()=>{
    const state=controller.state();$('allow').checked=state.ready;$('start').disabled=!state.ready;
    $('state').textContent=state.remaining?`Запись · ${state.remaining} с`:'Остановлено';
    $('preview').textContent=controller.text || 'Ответ не запрошен';$('events').replaceChildren();
    for(const event of controller.events){
      const row=document.createElement('tr');
      for(const text of [event.host,event.method,String(event.status || 'ошибка'),`${event.duration_ms} мс`]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}
      const cell=document.createElement('td'),button=document.createElement('button');button.textContent='Показать текст';
      button.onclick=()=>controller.preview(event.event).catch(error=>{$('message').textContent=error.message;});cell.append(button);row.append(cell);$('events').append(row);
    }
  };
  $('allow').onchange=()=>controller.allow($('allow').checked);
  $('start').onclick=()=>controller.start();$('stop').onclick=()=>controller.stop();$('clear').onclick=()=>{controller.clear();if(controller.state().remaining)controller.emit({op:'reset',session:controller.session});};
  controller.onChange=render;render();
};
