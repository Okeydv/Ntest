// Интеграционный тест per-device модели ключей.
//
// Проверяет то, что нельзя проверить компиляцией: что пулы one-time
// prekeys у устройств независимы, что bundle отдаётся набором, что отзыв
// одного устройства не трогает остальные и что подпись signed prekey
// привязана к identity-ключу именно того устройства.
//
// Запуск (нужны живой Postgres и запущенный сервис):
//
//   PGDATA=/var/lib/postgresql/nyxo-test
//   initdb -D $PGDATA -A trust -U postgres
//   pg_ctl -D $PGDATA -o "-p 55432 -k $PGDATA" start
//   psql -h $PGDATA -p 55432 -U postgres -c 'CREATE DATABASE nyxo_test'
//
//   DATABASE_URL='postgres://postgres@%2Fvar%2Flib%2Fpostgresql%2Fnyxo-test:55432/nyxo_test' \
//   INTERNAL_SHARED_SECRET='test-secret-at-least-32-chars-long-xx' \
//   BIND_ADDR='127.0.0.1:7421' cargo run
//
//   node scripts/integration-test.mjs
//
// Тест рассчитан на ЧИСТУЮ базу: он оставляет после себя удалённый
// аккаунт 1, повторный прогон без пересоздания БД пройдёт, но полагаться
// на это не стоит.
const BASE = 'http://127.0.0.1:7421';
const SECRET = 'test-secret-at-least-32-chars-long-xx';
let fails = 0;

const raw = (k) => k.export({ type: 'spki', format: 'der' }).subarray(-32);
const b64 = (b) => Buffer.from(b).toString('base64');

function makeDevice() {
  const id = crypto.generateKeyPairSync('ed25519');
  const dh = crypto.generateKeyPairSync('x25519');
  const spk = crypto.generateKeyPairSync('x25519');
  const spkPub = raw(spk.publicKey);
  return { id, dh, spkPub, sig: crypto.sign(null, spkPub, id.privateKey) };
}

async function call(method, path, { user, device, body, secret = SECRET } = {}) {
  const headers = { 'X-Internal-Secret': secret };
  if (user !== undefined) headers['X-User-Id'] = String(user);
  if (device !== undefined) headers['X-Device-Id'] = String(device);
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

function check(label, cond, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) fails++;
}

async function onboard(user, device, dev, opkCount) {
  await call('PUT', '/internal/v1/keys/identity', { user, device,
    body: { identity_signing_key: b64(raw(dev.id.publicKey)), identity_dh_key: b64(raw(dev.dh.publicKey)) } });
  await call('PUT', '/internal/v1/keys/signed-prekey', { user, device,
    body: { key_id: 1, public_key: b64(dev.spkPub), signature: b64(dev.sig) } });
  const keys = Array.from({ length: opkCount }, (_, i) => ({
    key_id: i + 1, public_key: b64(raw(crypto.generateKeyPairSync('x25519').publicKey)) }));
  const r = await call('POST', '/internal/v1/keys/one-time-prekeys', { user, device, body: { keys } });
  return r.json?.inserted;
}

// Пулы намеренно разного размера: так видно, что устройства независимы.
const d101 = makeDevice(), d102 = makeDevice();
check('OPK загружены устройству 101 (1 шт)', await onboard(1, 101, d101, 1) === 1);
check('OPK загружены устройству 102 (3 шт)', await onboard(1, 102, d102, 3) === 3);

let b = await call('GET', '/internal/v1/keys/bundle/1', { user: 2 });
const ids = (b.json?.bundles ?? []).map(x => x.device_id);
check('bundle отдаёт набор по всем устройствам', JSON.stringify(ids) === '[101,102]', 'device_id: ' + JSON.stringify(ids));
check('у каждого устройства свой identity-ключ',
  b.json.bundles[0].identity_dh_key !== b.json.bundles[1].identity_dh_key);
check('каждому устройству выдан свой OPK',
  b.json.bundles.every(x => x.one_time_prekey) &&
  b.json.bundles[0].one_time_prekey.public_key !== b.json.bundles[1].one_time_prekey.public_key);

const c101 = await call('GET', '/internal/v1/keys/one-time-prekeys/count', { user: 1, device: 101 });
const c102 = await call('GET', '/internal/v1/keys/one-time-prekeys/count', { user: 1, device: 102 });
check('пулы OPK расходуются независимо', c101.json.count === 0 && c102.json.count === 2,
  `101: ${c101.json.count}, 102: ${c102.json.count}`);
check('счётчик сообщает, о чьём пуле речь', c101.json.device_id === 101);

b = await call('GET', '/internal/v1/keys/bundle/1', { user: 2 });
const by = Object.fromEntries(b.json.bundles.map(x => [x.device_id, x]));
check('исчерпание OPK у одного устройства не ломает другое',
  by[101].one_time_prekey === null && by[102].one_time_prekey !== null);
check('устройство без OPK всё равно в наборе (X3DH деградирует, но работает)', !!by[101].signed_prekey);

// Отзыв одного устройства
await call('DELETE', '/internal/v1/keys/device', { user: 1, device: 102 });
b = await call('GET', '/internal/v1/keys/bundle/1', { user: 2 });
check('отзыв устройства убирает только его ключи',
  b.json.bundles.length === 1 && b.json.bundles[0].device_id === 101);

// Привязка подписи к устройству: SPK, подписанный чужим identity-ключом
const foreign = makeDevice();
const bad = await call('PUT', '/internal/v1/keys/signed-prekey', { user: 1, device: 101,
  body: { key_id: 9, public_key: b64(foreign.spkPub), signature: b64(foreign.sig) } });
check('SPK, подписанный ключом другого устройства, отвергается', bad.status === 400,
  'status ' + bad.status);

// Негативные проверки заголовков
check('без X-Device-Id — отказ', (await call('GET', '/internal/v1/keys/one-time-prekeys/count', { user: 1 })).status === 401);
check('device_id = 0 запрещён', (await call('GET', '/internal/v1/keys/one-time-prekeys/count', { user: 1, device: 0 })).status === 400);
check('неверный секрет — отказ', (await call('GET', '/internal/v1/keys/one-time-prekeys/count', { user: 1, device: 101, secret: 'x'.repeat(37) })).status === 401);
check('у пользователя без устройств — 404', (await call('GET', '/internal/v1/keys/bundle/999', { user: 1 })).status === 404);

// Удаление по аккаунту
await call('DELETE', '/internal/v1/keys', { user: 1 });
check('удаление аккаунта снимает все устройства', (await call('GET', '/internal/v1/keys/bundle/1', { user: 2 })).status === 404);

console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
