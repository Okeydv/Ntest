// Тот же модуль E2EE, но в настоящем браузере (Chromium через Playwright).
//
// Зачем отдельно от scripts/test-e2ee-crypto.mjs: Node и браузер — разные
// реализации WebCrypto, и проверять надо ту, где код будет работать.
// Плюс здесь проверяется то, чего в Node нет вовсе:
//   - identity-ключи создаются НЕИЗВЛЕКАЕМЫМИ (extractable: false)
//   - состояние сессии переживает IndexedDB
//
// Запуск: node scripts/test-e2ee-crypto-browser.mjs
import { launch, finish } from './lib/browser.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const srv = http.createServer((q,r) => {
  const u = q.url.split('?')[0];
  if (u === '/') { r.writeHead(200,{'content-type':'text/html'});
    return r.end('<!doctype html><meta charset="utf-8"><title>e2ee</title>'); }
  const f = path.join(ROOT, u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200,{'content-type': f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream'});
  r.end(fs.readFileSync(f));
});
await new Promise(r => srv.listen(4181, r));
const b = await launch();
const p = await (await b.newContext()).newPage();
p.on('pageerror', e => console.error('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:4181/');

const out = await p.evaluate(async () => {
  const m = await import('/crypto/e2ee.js');
  const res = []; const ok = (l,c,d='') => res.push([l,c,d]);

  async function device() {
    const identity = await m.generateIdentity();           // неизвлекаемые, как в бою
    const spk = await m.generateSignedPrekey(identity, 1);
    const opks = await m.generateOneTimePrekeys(1, 2);
    const pool = new Map(opks.items.map(o => [o.keyId, o]));
    return { identity, spk,
      lookupSignedPrekey: async id => id === spk.keyId ? spk : null,
      lookupOneTimePrekey: async id => { const o = pool.get(id); if (o) pool.delete(id); return o || null; },
      bundle: async () => { const pub = await m.exportIdentityPublic(identity);
        const o = [...pool.values()][0];
        return { ...pub, signed_prekey: spk.upload,
                 one_time_prekey: o ? { key_id:o.keyId, public_key:m.toB64(o.publicKey) } : null }; } };
  }
  const send = async (s,t) => { const e = await m.encryptMessage(s,t);
    return { header: m.fromB64(m.toB64(e.header)), ciphertext: m.fromB64(m.toB64(e.ciphertext)), type: e.type }; };
  const recv = (s,e) => m.decryptToText(s, e.header, e.ciphertext);

  try {
    const A = await device(), B = await device();
    ok('identity создан неизвлекаемым', A.identity.dh.privateKey.extractable === false);

    let sa = await m.initiateSession({ identity: A.identity, bundle: await B.bundle() });
    const m1 = await send(sa, 'привет из браузера');
    let sb = await m.acceptSession({ identity: B.identity, header: m.parseHeader(m1.header),
      lookupSignedPrekey: B.lookupSignedPrekey, lookupOneTimePrekey: B.lookupOneTimePrekey });
    ok('X3DH и первое сообщение', await recv(sb, m1) === 'привет из браузера');

    const r1 = await send(sb, 'ответ');
    ok('DH-рэтчет в обратную сторону', await recv(sa, r1) === 'ответ');

    const a1 = await send(sa,'1'), a2 = await send(sa,'2'), a3 = await send(sa,'3');
    ok('доставка не по порядку', await recv(sb,a3)==='3' && await recv(sb,a1)==='1' && await recv(sb,a2)==='2');

    const bad = await send(sa,'секрет'); bad.ciphertext[0] ^= 1;
    let rejected = false; try { await recv(sb,bad); } catch { rejected = true; }
    ok('подмена шифротекста отвергается', rejected);

    // Состояние в IndexedDB структурным клонированием — как будет в бою
    const st = await m.exportSession(sa);
    const db = await new Promise((res2,rej)=>{ const q=indexedDB.open('nyxo-test',1);
      q.onupgradeneeded=()=>q.result.createObjectStore('s'); q.onsuccess=()=>res2(q.result); q.onerror=()=>rej(q.error); });
    await new Promise((res2,rej)=>{ const tx=db.transaction('s','readwrite');
      tx.objectStore('s').put(st,'x'); tx.oncomplete=res2; tx.onerror=()=>rej(tx.error); });
    const back = await new Promise((res2,rej)=>{ const tx=db.transaction('s','readonly');
      const q=tx.objectStore('s').get('x'); q.onsuccess=()=>res2(q.result); q.onerror=()=>rej(q.error); });
    sa = await m.importSession(back);
    const after = await send(sa, 'после IndexedDB');
    ok('сессия переживает IndexedDB и переписка продолжается', await recv(sb, after) === 'после IndexedDB');
  } catch (e) { ok('исключение: ' + e.message, false); }
  return res;
});
let fails = 0;
for (const [l,c,d] of out) { console.log(`${c?'ok  ':'FAIL'}  ${l}${d?'  — '+d:''}`); if(!c) fails++; }
console.log(fails ? `\n${fails} провалено` : '\nмодуль работает в браузере');
await finish(b, fails); srv.close(); process.exit(fails?1:0);
