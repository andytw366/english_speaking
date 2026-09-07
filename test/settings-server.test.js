// 從網頁改金鑰的那條路（server/settings.js）。
//
// 為什麼這一份要有：這裡是**唯一一個會寫入伺服器檔案系統、而且寫的是金鑰**
// 的端點，門禁以前靠「只放行 loopback」、現在靠「要是擁有者」。
// 兩種錯法都沒有徵兆：
//   - 門禁寫錯 → 家裡其他帳號也能改你的金鑰，而畫面上看起來完全正常；
//   - 寫檔寫錯 → 存的時候回「已儲存」，但重啟之後值不見了或被 dotenv 讀錯，
//     症狀是「跟讀突然說沒設定金鑰」。
// 所以這一份釘的是門禁、檔案內容、以及**dotenv 讀回來要跟存進去的一樣**。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';

import {
  SETTINGS_FILENAME, SettingsError, assertOwner, readSettings, settingsPath,
  valueProblem, writeSettings,
} from '../server/settings.js';
import { createStore } from '../server/store.js';
import { hashPassword } from '../server/auth.js';

const tempDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'sc-settings-'));

/** 這幾條測試會動 process.env（writeSettings 會立刻套用），跑完要收乾淨。 */
function withCleanEnv(keys, fn) {
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 接住 SettingsError 並回傳它。`assert.throws()` 不回傳錯誤，而這裡要看 httpStatus。 */
function caught(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SettingsError, `丟的不是 SettingsError：${err}`);
    return err;
  }
  return assert.fail('應該要丟 SettingsError，但沒有');
}

// ─── 門禁：只有擁有者 ────────────────────────────────────────────────────

test('沒登入是 401，不是 403 —— 訊息要對得上實際情況', () => {
  const err = caught(() => assertOwner(null, { id: 'a' }));
  assert.equal(err.httpStatus, 401);
});

test('登入了但不是擁有者：403，而且講清楚是誰才可以', () => {
  // INVITE_CODE 開著的時候家裡其他人也有帳號，而金鑰是會花錢的東西
  const err = caught(() => assertOwner({ id: 'member' }, { id: 'owner', username: 'andy' }));
  assert.equal(err.httpStatus, 403);
  assert.match(err.userMessage, /擁有者/);
  assert.match(err.userMessage, /andy/);
});

test('擁有者本人放行', () => {
  assertOwner({ id: 'owner' }, { id: 'owner', username: 'andy' });
});

test('一個帳號都沒有時擋下來，不是當成放行', () => {
  // 這個情況正常走不到（authGate 會先擋），但預設值錯的方向差很多
  const err = caught(() => assertOwner({ id: 'x' }, null));
  assert.equal(err.httpStatus, 403);
});

// ─── 誰是擁有者 ──────────────────────────────────────────────────────────

test('第一個註冊的帳號是擁有者，第二個不是', async () => {
  const store = createStore(await tempDir());
  await store.init();
  const first = await store.createUser('andy', await hashPassword('correct-horse-battery'));
  const second = await store.createUser('mei', await hashPassword('correct-horse-battery'));

  assert.equal(first.role, 'owner');
  assert.equal(second.role, 'member');
  assert.equal((await store.owner()).id, first.id);
});

test('舊的 users.json 沒有 role 欄位時，第一個還是算擁有者', async () => {
  // 帳號是在這個功能之前建的。少了這條退路的話，既有的部署升級之後
  // 會變成「沒有人是擁有者」，誰都改不了金鑰
  const dir = await tempDir();
  const store = createStore(dir);
  await store.init();
  await fsp.writeFile(path.join(dir, 'users.json'), JSON.stringify({
    users: [
      { id: 'old-1', username: 'andy', passwordHash: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'old-2', username: 'mei', passwordHash: 'x', createdAt: '2026-02-01T00:00:00.000Z' },
    ],
  }));

  assert.equal((await store.owner()).id, 'old-1');
});

// ─── 值的檢查 ────────────────────────────────────────────────────────────

test('換行一律拒收（貼上時最容易帶進來的東西）', () => {
  assert.match(valueProblem('GEMINI_API_KEY', 'abc\ndef'), /換行/);
  assert.match(valueProblem('GEMINI_API_KEY', 'abc\r\ndef'), /換行/);
});

test('空字串永遠合法 —— 那是「清除這一項」', () => {
  for (const key of ['GEMINI_API_KEY', 'AZURE_SPEECH_REGION', 'NARRATION_PROVIDER',
    'NARRATION_BASE_URL']) {
    assert.equal(valueProblem(key, ''), null);
  }
});

test('Azure 區域要是小寫英數 —— 貼「East Asia」或整個網址是最常見的錯法', () => {
  assert.equal(valueProblem('AZURE_SPEECH_REGION', 'eastasia'), null);
  assert.equal(valueProblem('AZURE_SPEECH_REGION', 'japan-east'), null);
  assert.match(valueProblem('AZURE_SPEECH_REGION', 'East Asia'), /小寫英數/);
  assert.match(
    valueProblem('AZURE_SPEECH_REGION', 'https://eastasia.api.cognitive.microsoft.com'),
    /小寫英數/,
  );
});

test('講評來源只有三個值，其他要講出可以填什麼', () => {
  for (const ok of ['gemini', 'openai', 'local', '']) {
    assert.equal(valueProblem('NARRATION_PROVIDER', ok), null);
  }
  assert.match(valueProblem('NARRATION_PROVIDER', 'groq'), /gemini \/ openai \/ local/);
});

test('講評端點要是 http(s) 網址，而且不要含 /chat/completions', () => {
  assert.equal(valueProblem('NARRATION_BASE_URL', 'https://router.huggingface.co/v1'), null);
  assert.equal(valueProblem('NARRATION_BASE_URL', 'http://localhost:11434/v1'), null);
  assert.match(valueProblem('NARRATION_BASE_URL', 'router.huggingface.co/v1'), /完整網址/);
  assert.match(valueProblem('NARRATION_BASE_URL', 'ftp://example.com/v1'), /http/);
  // 連著填會變成 …/chat/completions/chat/completions，而錯誤訊息只會說 404
  assert.match(
    valueProblem('NARRATION_BASE_URL', 'https://api.groq.com/openai/v1/chat/completions'),
    /不要含/,
  );
});

// ─── 寫檔 ────────────────────────────────────────────────────────────────

test('寫進 DATA_DIR/settings.env，不是專案的 .env', async () => {
  const dir = await tempDir();
  await withCleanEnv(['GEMINI_API_KEY'], () => {
    const updated = writeSettings(dir, { GEMINI_API_KEY: 'AIzaTESTKEY1234' });
    assert.deepEqual(updated, ['GEMINI_API_KEY']);
  });

  assert.equal(settingsPath(dir), path.join(dir, SETTINGS_FILENAME));
  assert.match(fs.readFileSync(settingsPath(dir), 'utf8'), /^GEMINI_API_KEY=AIzaTESTKEY1234$/m);
});

test('存了立刻套用到 process.env（不用重啟）', async () => {
  const dir = await tempDir();
  await withCleanEnv(['GEMINI_API_KEY'], () => {
    writeSettings(dir, { GEMINI_API_KEY: 'AIzaTESTKEY1234' });
    assert.equal(process.env.GEMINI_API_KEY, 'AIzaTESTKEY1234');
    assert.equal(readSettings().GEMINI_API_KEY.preview, '••••1234');

    // 空字串是「清除」——**要真的從 process.env 消失**，
    // 留一個空字串在那裡的話 hasApiKey() 之類的檢查會怎麼寫都對不了
    writeSettings(dir, { GEMINI_API_KEY: '' });
    assert.equal(process.env.GEMINI_API_KEY, undefined);
    assert.equal(readSettings().GEMINI_API_KEY.configured, false);
  });
});

test('改一個變數不會動到檔案裡的其他行（註解與別的變數都留著）', async () => {
  const dir = await tempDir();
  fs.writeFileSync(settingsPath(dir), [
    '# 手寫的註解',
    'GEMINI_API_KEY=old-key',
    'SOMETHING_ELSE=keep-me',
    '',
  ].join('\n'));

  await withCleanEnv(['GEMINI_API_KEY', 'NARRATION_MODEL'], () => {
    writeSettings(dir, { GEMINI_API_KEY: 'new-key', NARRATION_MODEL: 'llama-3.3-70b' });
  });

  const lines = fs.readFileSync(settingsPath(dir), 'utf8').trim().split('\n');
  assert.deepEqual(lines, [
    '# 手寫的註解',
    'GEMINI_API_KEY=new-key',
    'SOMETHING_ELSE=keep-me',
    'NARRATION_MODEL=llama-3.3-70b',
  ]);
});

test('不在白名單裡的變數一律忽略', async () => {
  const dir = await tempDir();
  await withCleanEnv(['GEMINI_API_KEY', 'PATH'], () => {
    // PATH 被寫進 .env 檔的話，下次啟動整個 process 的 PATH 就被換掉了
    const updated = writeSettings(dir, { GEMINI_API_KEY: 'k', PATH: '/tmp/evil' });
    assert.deepEqual(updated, ['GEMINI_API_KEY']);
  });
  assert.doesNotMatch(fs.readFileSync(settingsPath(dir), 'utf8'), /PATH/);
});

test('沒有任何認得的變數就 400，不要寫出一個空檔案', async () => {
  const dir = await tempDir();
  const err = caught(() => writeSettings(dir, { NOPE: 'x' }));
  assert.equal(err.httpStatus, 400);
  assert.equal(fs.existsSync(settingsPath(dir)), false);
});

test('壞值在寫檔之前就擋掉 —— 不要留下寫了一半的檔案', async () => {
  const dir = await tempDir();
  const err = caught(
    () => writeSettings(dir, { GEMINI_API_KEY: 'good', AZURE_SPEECH_REGION: 'East Asia' }),
  );
  assert.equal(err.httpStatus, 400);
  assert.equal(fs.existsSync(settingsPath(dir)), false);
});

test('檔案權限是 600 —— 同一台機器上的其他使用者讀不到金鑰', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows 沒有這種權限位');
  const dir = await tempDir();
  await withCleanEnv(['GEMINI_API_KEY'], () => writeSettings(dir, { GEMINI_API_KEY: 'k' }));
  assert.equal(fs.statSync(settingsPath(dir)).mode & 0o777, 0o600);
});

test('dotenv 讀回來的值跟存進去的一模一樣（含空白與 # 的值）', async () => {
  // 這是最容易靜靜壞掉的一段：dotenv 會把沒加引號的值後面的 ` #` 當註解砍掉，
  // 而症狀是「重啟之後金鑰變成半截」——存的時候完全看不出來
  const dir = await tempDir();
  const value = 'weird value #not-a-comment';
  await withCleanEnv(['NARRATION_MODEL'], () => {
    writeSettings(dir, { NARRATION_MODEL: value });
  });

  const parsed = dotenv.parse(fs.readFileSync(settingsPath(dir)));
  assert.equal(parsed.NARRATION_MODEL, value);
});

test('值裡有單引號就拒收，不要寫出一個 dotenv 讀不回來的檔案', async () => {
  const dir = await tempDir();
  const err = caught(() => writeSettings(dir, { NARRATION_MODEL: "it's-broken now" }));
  assert.equal(err.httpStatus, 400);
});

test('回報永遠不含完整金鑰', async () => {
  await withCleanEnv(['AZURE_SPEECH_KEY', 'NARRATION_API_KEY'], () => {
    process.env.AZURE_SPEECH_KEY = 'super-secret-key-9876';
    process.env.NARRATION_API_KEY = 'hf_secret_5432';
    const json = JSON.stringify(readSettings());
    assert.doesNotMatch(json, /super-secret-key-9876/);
    assert.doesNotMatch(json, /hf_secret_5432/);
    assert.match(json, /••••9876/);
    assert.match(json, /••••5432/);
  });
});

test('不是機密的值（區域、端點、model）回完整值 —— 設定頁要顯示它', async () => {
  await withCleanEnv(['AZURE_SPEECH_REGION', 'NARRATION_BASE_URL', 'NARRATION_MODEL',
    'NARRATION_PROVIDER'], () => {
    process.env.AZURE_SPEECH_REGION = 'eastasia';
    process.env.NARRATION_BASE_URL = 'https://router.huggingface.co/v1';
    process.env.NARRATION_MODEL = 'llama-3.3-70b:groq';
    process.env.NARRATION_PROVIDER = 'openai';
    const s = readSettings();
    assert.equal(s.AZURE_SPEECH_REGION.value, 'eastasia');
    assert.equal(s.NARRATION_BASE_URL.value, 'https://router.huggingface.co/v1');
    assert.equal(s.NARRATION_MODEL.value, 'llama-3.3-70b:groq');
    assert.equal(s.NARRATION_PROVIDER.value, 'openai');
  });
});
