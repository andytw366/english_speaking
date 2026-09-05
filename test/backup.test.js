// 學習資料的備份檔。
//
// 這裡的重點全部在**還原**那一側：匯出寫壞了頂多是檔案沒用，
// 匯入寫壞了是把現有的複習進度覆蓋成半殘的資料，而且沒有第二次機會
//（還原是覆蓋不是合併，而且覆蓋完就沒有舊的了）。
// 所以每一種「壞掉的檔案」都要有一條測試擋著。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBackup, parseBackup, backupSummary, summaryText, backupFilename,
  BACKUP_VERSION, BACKUP_APP, BACKUP_KEYS,
} from '../public/lib/backup.js';

const STATE = {
  srs: { 'ecdict:1': { box: 5, due: 1, seen: 6, correct: 6 }, 'curated:2': { box: 1 } },
  srsVersion: 2,
  vocabDays: { '2026-09-04': 20, '2026-09-05': 12 },
  history: [{ sentenceId: 3, score: 88 }, { sentenceId: 4, score: 72 }],
  settings: { vocabDailyGoal: 20, vocabDeck: 'tier-2' },
};
const NOW = Date.parse('2026-09-05T04:30:00Z');

// ─── 匯出 ────────────────────────────────────────────────────────────────

test('備份帶走全部五種資料，並標上 app 與版本', () => {
  const backup = buildBackup(STATE, NOW);

  assert.equal(backup.app, BACKUP_APP);
  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(backup.exportedAt, '2026-09-05T04:30:00.000Z');
  assert.deepEqual(Object.keys(backup.data).sort(), [...BACKUP_KEYS].sort());
});

test('沒有的鍵就不寫進去（不要把 undefined 存成 null）', () => {
  const backup = buildBackup({ srs: { a: 1 } }, NOW);
  assert.deepEqual(Object.keys(backup.data), ['srs']);
});

test('白名單以外的鍵不會被帶走', () => {
  // localStorage 裡可能有別的 App 或舊版留下的鍵，備份不該把它們一起搬走
  const backup = buildBackup({ ...STATE, 亂七八糟: '不該出現', token: 'secret' }, NOW);
  assert.ok(!('亂七八糟' in backup.data));
  assert.ok(!('token' in backup.data));
});

// ─── 還原前的把關 ────────────────────────────────────────────────────────

const rejects = (text, pattern) => {
  assert.throws(() => parseBackup(text), pattern, `這個輸入應該被擋下來：${String(text).slice(0, 40)}`);
};

test('不是 JSON 的檔案被擋下來', () => {
  rejects('這不是 JSON', /JSON/);
  rejects('', /JSON/);
});

test('別的 App 的匯出檔被擋下來', () => {
  rejects(JSON.stringify({ version: 1, data: { srs: {} } }), /備份檔/);
  rejects(JSON.stringify({ app: 'anki', version: 1, data: { srs: {} } }), /備份檔/);
});

test('最外層不是物件的被擋下來', () => {
  rejects('[]', /格式/);
  rejects('"字串"', /格式/);
  rejects('null', /格式/);
});

test('版本比程式新的擋下來 —— 形狀可能對不上，寧可不還原', () => {
  const future = JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION + 1, data: { srs: {} } });
  assert.throws(() => parseBackup(future), /較新的版本/);
});

test('沒有版本號的擋下來', () => {
  rejects(JSON.stringify({ app: BACKUP_APP, data: { srs: {} } }), /版本/);
  rejects(JSON.stringify({ app: BACKUP_APP, version: 'x', data: { srs: {} } }), /版本/);
});

test('data 不見或不是物件的擋下來（檔案被截斷）', () => {
  rejects(JSON.stringify({ app: BACKUP_APP, version: 1 }), /data/);
  rejects(JSON.stringify({ app: BACKUP_APP, version: 1, data: [] }), /data/);
});

test('一個認得的鍵都沒有時擋下來 —— 還原下去等於把進度清空', () => {
  const empty = JSON.stringify({ app: BACKUP_APP, version: 1, data: { 別的東西: 1 } });
  assert.throws(() => parseBackup(empty), /清空/);
});

test('手改過的備份檔塞不進白名單以外的鍵', () => {
  const tampered = JSON.stringify({
    app: BACKUP_APP, version: 1,
    data: { srs: { a: 1 }, 'evil-key': '不該被寫進 localStorage' },
  });
  const { data } = parseBackup(tampered);
  assert.deepEqual(Object.keys(data), ['srs']);
});

// ─── 一來一回 ────────────────────────────────────────────────────────────

test('匯出再匯入拿回一模一樣的資料', () => {
  const text = JSON.stringify(buildBackup(STATE, NOW));
  const { data, version, exportedAt } = parseBackup(text);

  assert.deepEqual(data, STATE);
  assert.equal(version, BACKUP_VERSION);
  assert.equal(exportedAt, '2026-09-05T04:30:00.000Z');
});

test('只有一部分資料的備份也還原得回去（舊版存的檔）', () => {
  const partial = JSON.stringify({ app: BACKUP_APP, version: 1, data: { srs: STATE.srs } });
  assert.deepEqual(parseBackup(partial).data, { srs: STATE.srs });
});

// ─── 摘要（覆蓋前要讓人看到「用什麼覆蓋」）────────────────────────────────

test('摘要數得出字數、天數與跟讀筆數', () => {
  const s = backupSummary(STATE);
  assert.equal(s.words, 2);
  assert.equal(s.days, 2);
  assert.equal(s.cards, 32);      // 20 + 12
  assert.equal(s.attempts, 2);
  assert.equal(s.hasSettings, true);
});

test('摘要不會因為資料壞掉就丟例外', () => {
  assert.doesNotThrow(() => backupSummary({}));
  assert.doesNotThrow(() => backupSummary(null));
  assert.equal(backupSummary({ vocabDays: { x: 'abc', y: -3 } }).cards, 0);
  assert.equal(backupSummary({ history: '不是陣列' }).attempts, 0);
});

test('摘要寫成一句話給人看', () => {
  const text = summaryText(backupSummary(STATE));
  assert.match(text, /單字進度 2 個字/);
  assert.match(text, /每日紀錄 2 天/);
  assert.match(text, /跟讀紀錄 2 筆/);
});

// ─── 檔名 ────────────────────────────────────────────────────────────────

test('檔名用本地日期 —— 使用者說的「今天」是他自己的今天', () => {
  // 本地時間的正午，不論時區都還是同一天
  const noon = new Date(2026, 8, 5, 12, 0, 0).getTime();
  assert.equal(backupFilename(noon), 'speaking-coach-backup-20260905.json');
});

test('檔名全是 ASCII —— 中文檔名會讓 Chromium 忽略整個 download 屬性', () => {
  // 實際踩過：檔案被存成 `download`，沒有副檔名
  assert.match(backupFilename(Date.now()), /^[\x20-\x7E]+$/);
});
