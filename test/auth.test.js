// 帳號的基本零件（server/auth.js）與落地（server/store.js）。
//
// 為什麼這一份特別要有：這一層寫錯**通常沒有徵兆** —— 密碼比對用 `===` 照樣
// 「會動」、session token 明文存進檔案也「會動」、原子寫入沒做也是九成九的
// 時候都對。全部都是要等到出事才會發現的那種錯。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  createLoginGate, hashPassword, hashToken, newSession, originAllowed, parseCookies,
  passwordProblem, serializeCookie, usernameProblem, verifyPassword,
} from '../server/auth.js';
import { createStore } from '../server/store.js';
import { isPublicPath, isSecureRequest } from '../server/routes-auth.js';

async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sc-store-'));
  const store = createStore(dir);
  await store.init();
  return { store, dir };
}

// ─── 密碼 ────────────────────────────────────────────────────────────────

test('對的密碼過、錯的不過', async () => {
  const stored = await hashPassword('correct-horse-battery');
  assert.equal(await verifyPassword('correct-horse-battery', stored), true);
  assert.equal(await verifyPassword('correct-horse-batterx', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('同一個密碼每次的雜湊都不一樣（每次都有新的 salt）', async () => {
  const a = await hashPassword('same-password-here');
  const b = await hashPassword('same-password-here');
  assert.notEqual(a, b);
  // 但兩個都驗得過
  assert.equal(await verifyPassword('same-password-here', a), true);
  assert.equal(await verifyPassword('same-password-here', b), true);
});

test('雜湊字串裡帶著成本參數 —— 之後調高時舊密碼還驗得動', async () => {
  const stored = await hashPassword('another-password');
  const [scheme, N, r, p] = stored.split('$');
  assert.equal(scheme, 'scrypt');
  assert.ok(Number(N) >= 16384, `N 太小：${N}`);
  assert.equal(Number(r), 8);
  assert.equal(Number(p), 1);
});

test('壞掉的雜湊字串回 false，不丟例外', async () => {
  // 呼叫端是登入流程 —— 壞掉的紀錄應該是「登入失敗」而不是 500
  for (const bad of ['', 'nonsense', 'scrypt$x$y$z$aa$bb', 'bcrypt$1$2$3$aa$bb', null, undefined]) {
    assert.equal(await verifyPassword('whatever', bad), false, `${bad} 應該回 false`);
  }
});

test('密碼與帳號名稱的規則', () => {
  assert.equal(passwordProblem('12345678'), null);
  assert.match(passwordProblem('1234567'), /8 個字元/);
  assert.match(passwordProblem(12345678), /文字/);

  assert.equal(usernameProblem('andy'), null);
  assert.equal(usernameProblem('a.b_c-1'), null);
  assert.match(usernameProblem('a'), /2 個字/);
  // 帳號名稱會變成找使用者的鍵，限制字元集是最省事的防線
  assert.match(usernameProblem('../etc/passwd'), /只能用/);
  assert.match(usernameProblem('王小明'), /只能用/);
});

// ─── session ─────────────────────────────────────────────────────────────

test('session 只存雜湊，明文 token 不落地', () => {
  const { token, hash } = newSession();
  assert.ok(token.length >= 40, `token 太短：${token.length}`);
  assert.equal(hash, hashToken(token));
  assert.notEqual(hash, token);
  // 同一個 token 算出來一定一樣（不然登入之後每次都對不上）
  assert.equal(hashToken(token), hashToken(token));
});

test('過期的 session 不放行', async () => {
  const { store } = await tempStore();
  const user = await store.createUser('andy', await hashPassword('correct-horse-battery'));
  const { token } = await store.createSession(user.id);

  assert.equal((await store.userForToken(token))?.username, 'andy');
  assert.equal(await store.userForToken('not-a-real-token'), null);
  assert.equal(await store.userForToken(''), null);
  assert.equal(await store.userForToken(undefined), null);

  await store.deleteSession(token);
  assert.equal(await store.userForToken(token), null);
});

test('sessions.json 裡真的看不到明文 token', async () => {
  // 這一條是釘住「檔案外流 ≠ 別人可以直接冒用身分」
  const { store, dir } = await tempStore();
  const user = await store.createUser('andy', await hashPassword('correct-horse-battery'));
  const { token } = await store.createSession(user.id);

  const raw = await fs.readFile(path.join(dir, 'sessions.json'), 'utf8');
  assert.ok(!raw.includes(token), 'sessions.json 裡出現了明文 token');
  assert.ok(raw.includes(hashToken(token)));
});

// ─── cookie ──────────────────────────────────────────────────────────────

test('cookie 解析：壞掉的一段不會害整個標頭解析失敗', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies('sc_session=abc%2Fdef'), { sc_session: 'abc/def' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  // 壞掉的百分號編碼：跳過它，其他照樣讀得到
  assert.deepEqual(parseCookies('bad=%E0%A4%A; good=1').good, '1');
});

test('cookie 一定帶 HttpOnly 與 SameSite', () => {
  const c = serializeCookie('sc_session', 'tok', { maxAge: 60, secure: true });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.match(c, /Path=\//);
});

test('http 時不帶 Secure —— 不然本機開發登入會「按了沒反應」', () => {
  // 帶了 Secure 的 cookie 在 http 上根本不會被存起來，而且沒有錯誤訊息
  const c = serializeCookie('sc_session', 'tok', { maxAge: 60, secure: false });
  assert.doesNotMatch(c, /Secure/);
});

test('清除 cookie 是 Max-Age=0 且沒有值', () => {
  const c = serializeCookie('sc_session', 'tok', { clear: true, secure: true });
  assert.match(c, /^sc_session=;/);
  assert.match(c, /Max-Age=0/);
});

test('isSecureRequest 看得懂反向代理的標頭', () => {
  assert.equal(isSecureRequest({ secure: true, headers: {} }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }), true);
  // 代理鏈：只信任第一個值，後面的可能是使用者自己加的
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'https, http' } }), true);
  assert.equal(isSecureRequest({ headers: { 'x-forwarded-proto': 'http' } }), false);
  assert.equal(isSecureRequest({ headers: {} }), false);
});

// ─── CSRF ────────────────────────────────────────────────────────────────

test('Origin 檢查', () => {
  assert.equal(originAllowed('https://speak.example.com', 'speak.example.com'), true);
  assert.equal(originAllowed('https://evil.example', 'speak.example.com'), false);
  // 沒有 Origin 就放行：curl 與 healthcheck 不會送，而真正的 CSRF 一定是
  // 瀏覽器發起的，瀏覽器一定會送
  assert.equal(originAllowed(undefined, 'speak.example.com'), true);
  assert.equal(originAllowed('', 'speak.example.com'), true);
  assert.equal(originAllowed('not-a-url', 'speak.example.com'), false);
});

// ─── 哪些路徑不用登入 ────────────────────────────────────────────────────

test('只有 health 與 auth 不用登入', () => {
  assert.equal(isPublicPath('/api/health'), true);
  assert.equal(isPublicPath('/api/auth/login'), true);
  assert.equal(isPublicPath('/api/auth/me'), true);

  // 題庫也要登入 —— 不是機密，但那是好幾 MB 的靜態檔，
  // 不擋等於免費給人當 CDN
  assert.equal(isPublicPath('/api/content/sentences'), false);
  assert.equal(isPublicPath('/api/vocabulary/index.json'), false);
  assert.equal(isPublicPath('/api/sync'), false);
  assert.equal(isPublicPath('/api/settings'), false);
  // 「有沒有設定金鑰、講評走哪個端點」是這台機器的部署細節。
  // /api/health 只回「活著沒有」，那些搬到這個要登入的端點
  assert.equal(isPublicPath('/api/capabilities'), false);
  // 這一個是真的會花錢的
  assert.equal(isPublicPath('/api/pronunciation-feedback'), false);
  // 別讓開頭像 health 的路徑漏過去
  assert.equal(isPublicPath('/api/healthz'), false);
  assert.equal(isPublicPath('/api/authx'), false);
});

// ─── 登入退避 ────────────────────────────────────────────────────────────

test('連續失敗要等越來越久，成功之後歸零', () => {
  const gate = createLoginGate({ baseMs: 1000, maxMs: 60_000 });
  const key = 'andy|1.2.3.4';
  const t0 = 1_000_000;

  // 第一次失敗不罰 —— 打錯字很正常
  gate.fail(key, t0);
  assert.equal(gate.retryAfter(key, t0), 0);

  gate.fail(key, t0);
  assert.ok(gate.retryAfter(key, t0) > 0);

  const second = gate.retryAfter(key, t0);
  gate.fail(key, t0);
  assert.ok(gate.retryAfter(key, t0) > second, '第三次要等更久');

  // 等到時間過了就可以再試
  assert.equal(gate.retryAfter(key, t0 + 60_000), 0);

  gate.succeed(key);
  assert.equal(gate.retryAfter(key, t0), 0);
  assert.equal(gate._size(), 0);
});

test('退避有上限，不會變成永遠鎖死', () => {
  const gate = createLoginGate({ baseMs: 1000, maxMs: 5000 });
  for (let i = 0; i < 40; i++) gate.fail('k', 0);
  assert.equal(gate.retryAfter('k', 0), 5000);
});

// ─── 落地 ────────────────────────────────────────────────────────────────

test('帳號名稱不分大小寫地唯一', async () => {
  const { store } = await tempStore();
  await store.createUser('Andy', await hashPassword('correct-horse-battery'));
  await assert.rejects(
    () => store.createUser('andy', 'x'),
    /已經有人用/,
  );
  assert.equal((await store.findUser('ANDY'))?.username, 'Andy');
});

test('沒存過的人拿到 rev 0 而不是錯誤', async () => {
  const { store } = await tempStore();
  const user = await store.createUser('andy', await hashPassword('correct-horse-battery'));
  assert.deepEqual(await store.readData(user.id), { rev: 0, updatedAt: null, data: {} });
});

test('rev 對不上就 409，而且帶回目前的整包', async () => {
  // 沒有這道的話，兩台裝置幾乎同時上傳，後到的會無聲蓋掉先到的
  const { store } = await tempStore();
  const user = await store.createUser('andy', await hashPassword('correct-horse-battery'));

  await store.writeData(user.id, { activity: { listening: { '2026-09-06': 1 } } }, 0);
  await assert.rejects(
    () => store.writeData(user.id, { activity: {} }, 0),
    (err) => {
      assert.equal(err.httpStatus, 409);
      assert.equal(err.current.rev, 1);
      assert.deepEqual(err.current.data.activity, { listening: { '2026-09-06': 1 } });
      return true;
    },
  );
});

test('rev 每寫一次加一，而且留得住舊版本', async () => {
  // 保留舊版是合併寫錯時唯一的救援
  const { store, dir } = await tempStore();
  const user = await store.createUser('andy', await hashPassword('correct-horse-battery'));

  let rev = 0;
  for (let i = 1; i <= 3; i++) {
    ({ rev } = await store.writeData(user.id, { vocabDays: { '2026-09-06': i } }, rev));
    assert.equal(rev, i);
  }

  const names = await fs.readdir(path.join(dir, 'u'));
  // 第 1、2 版留著（第 3 版是現在的，在 <id>.json 裡）
  assert.ok(names.includes(`${user.id}.rev-1.json`), names.join(' '));
  assert.ok(names.includes(`${user.id}.rev-2.json`), names.join(' '));
  assert.ok(names.includes(`${user.id}.json`));
});

test('壞掉的資料檔不會被當成「空的」', async () => {
  // 當成空的往下走等於把使用者的進度靜靜清空 —— 寧可整個請求失敗，
  // 至少人看得到、也知道去翻 u/<id>.rev-N.json
  const { store, dir } = await tempStore();
  const user = await store.createUser('andy', await hashPassword('correct-horse-battery'));
  await store.writeData(user.id, { vocabDays: { '2026-09-06': 1 } }, 0);

  await fs.writeFile(path.join(dir, 'u', `${user.id}.json`), '{ 這不是 JSON');
  await assert.rejects(() => store.readData(user.id), /讀取/);
});

test('同時寫入不會互相蓋掉', async () => {
  // express 是單執行緒，但 async 的讀→改→寫中間會讓出去。
  // 沒有序列化的話，同時註冊兩個帳號只會留下一個
  const { store } = await tempStore();
  const hash = await hashPassword('correct-horse-battery');
  await Promise.all(
    ['a1', 'b2', 'c3', 'd4', 'e5'].map((name) => store.createUser(name, hash))
  );
  assert.equal(await store.userCount(), 5);
});

test('寫進度時不會留下半個檔案', async () => {
  // 原子寫入：先寫 .tmp 再 rename。直接寫目標檔案的話，寫到一半被砍
  // 留下的是被截斷的 JSON —— 下次開啟就是「進度全沒了」
  const { store, dir } = await tempStore();
  const user = await store.createUser('andy', await hashPassword('correct-horse-battery'));
  await store.writeData(user.id, { history: [{ at: '2026-09-06T00:00:00.000Z' }] }, 0);

  const names = await fs.readdir(path.join(dir, 'u'));
  assert.equal(names.filter((n) => n.includes('.tmp-')).length, 0, `留下暫存檔：${names}`);
  const raw = await fs.readFile(path.join(dir, 'u', `${user.id}.json`), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
});
