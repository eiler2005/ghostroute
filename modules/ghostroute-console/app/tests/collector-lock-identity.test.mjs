import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {acquireCollectorLock} from '../scripts/lib/collector-lock.mjs';

test('Linux collector recovers a legacy lock whose PID belongs to another process', {skip:process.platform!=='linux'}, async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collector-identity-'));
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
 await once(child,'spawn');
 try {
  const file=path.join(dir,'collector.lock');
  fs.writeFileSync(file,`collector ${child.pid} 2026-01-01T00:00:00Z\n`);
  const release=acquireCollectorLock(file,'collector',60000);
  assert.equal(typeof release,'function');
  assert.match(fs.readFileSync(file,'utf8'),/identity=/);
  release();
  assert.doesNotThrow(()=>process.kill(child.pid,0),'recovery must not terminate the unrelated process');
 } finally {child.kill();fs.rmSync(dir,{recursive:true,force:true});}
});

test('active peer identity prevents concurrent writer; changed process identity permits recovery',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'collector-peer-'));
 const file=path.join(dir,'collector-writer.lock');
 const moduleUrl=new URL('../scripts/lib/collector-lock.mjs',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireCollectorLock} from ${JSON.stringify(moduleUrl)};acquireCollectorLock(${JSON.stringify(file)},'peer',60000);console.log('ready');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','inherit']});
 await once(child.stdout,'data');
 try {
  assert.equal(acquireCollectorLock(file,'collector',60000),null);
  if(process.platform==='linux') {
   fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace(/identity=\S+/,'identity=old-boot:1'));
   const release=acquireCollectorLock(file,'collector',60000);
   assert.equal(typeof release,'function');
   fs.writeFileSync(file,'replacement-owner');
   release();
   assert.equal(fs.readFileSync(file,'utf8'),'replacement-owner','old owner cannot unlink a replacement lock');
  }
 } finally {child.kill();await once(child,'exit');fs.rmSync(dir,{recursive:true,force:true});}
});
