'use strict';
const GuardCounts=(()=>{
  const exactFormat=new Intl.NumberFormat('ru-RU');
  const compactFormat=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:1,useGrouping:false});
  const number=value=>Number.isFinite(value)?Math.max(0,Math.min(Number.MAX_SAFE_INTEGER,Math.floor(value))):0;
  function compact(value,badge=false){
    const n=number(value);
    if(n<1000)return String(n);
    if(badge && n>=1e15)return '999+';
    const units=[[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'k']];
    const [scale,suffix]=units.find(([scale])=>n>=scale);
    const factor=badge && n/scale>=10?1:10;
    return compactFormat.format(Math.floor(n/scale*factor)/factor)+suffix;
  }
  return {compact,badge:value=>compact(value,true),exact:value=>exactFormat.format(number(value))};
})();
globalThis.GuardCounts=GuardCounts;
