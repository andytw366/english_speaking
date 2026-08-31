import fs from 'node:fs';
import path from 'node:path';

// 從瀏覽器設定 API 金鑰。
//
// 安全邊界：這個 App 是設計成在本機執行的，金鑰寫進伺服器端的 .env，
// 瀏覽器只是把值送過來一次，不會存在前端、也不會回傳完整金鑰。
// 但「讓網頁寫入伺服器的 .env」在公開網路上是很危險的，
// 所以下面的 assertLocalRequest() 會擋掉所有非 loopback 的請求。
// 如果之後要部署到雲端，必須把這整個模組拿掉或加上真正的認證。

const MANAGED_KEYS = ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'GEMINI_API_KEY'];

export class SettingsError extends Error {
  constructor(httpStatus, userMessage) {
    super(userMessage);
    this.httpStatus = httpStatus;
    this.userMessage = userMessage;
  }
}

/**
 * 只允許本機請求 —— 這個端點會寫入 .env，不能讓區網或外部碰到。
 *
 * 注意這一關在**反向代理後面會一律擋掉**（Docker 部署就是這種情形：
 * 請求從 Caddy 的容器 IP 進來，不是 127.0.0.1）。那是刻意的、也是對的 ——
 * 代理會把所有人的請求都變成「內部來源」，放行等於門戶大開。
 * 那種部署下金鑰請直接寫在 .env 裡。
 */
export function assertLocalRequest(req) {
  const raw = req.socket?.remoteAddress ?? req.ip ?? '';
  const ip = raw.replace(/^::ffff:/, '');
  if (ip !== '127.0.0.1' && ip !== '::1') {
    throw new SettingsError(
      403,
      '基於安全考量，這個頁面不能修改金鑰設定 —— 只有直接連到伺服器本機' +
        '（http://localhost:3000）的請求才可以。\n' +
        '如果你是透過 Docker 的 Caddy 或其他反向代理連進來的，' +
        '請改成直接編輯專案根目錄的 .env 再重啟容器：這個端點會寫入 .env，' +
        '而代理背後的請求無法分辨是誰送的。'
    );
  }
}

/** 只回報「有沒有設定」與末四碼，永遠不回傳完整金鑰。 */
function mask(value) {
  if (!value) return { configured: false, preview: '' };
  const v = String(value);
  return {
    configured: true,
    preview: v.length <= 4 ? '••••' : `••••${v.slice(-4)}`,
  };
}

export function readSettings() {
  return {
    AZURE_SPEECH_KEY: mask(process.env.AZURE_SPEECH_KEY?.trim()),
    // 區域不是機密，直接回完整值方便顯示
    AZURE_SPEECH_REGION: {
      configured: Boolean(process.env.AZURE_SPEECH_REGION?.trim()),
      value: process.env.AZURE_SPEECH_REGION?.trim() ?? '',
    },
    GEMINI_API_KEY: mask(process.env.GEMINI_API_KEY?.trim()),
  };
}

/**
 * 更新 .env 裡指定的幾個變數，其餘內容（註解、其他變數）原樣保留。
 * 值傳空字串代表清除該設定。
 */
export function writeSettings(root, updates) {
  const envPath = path.join(root, '.env');

  const clean = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!MANAGED_KEYS.includes(key)) continue;
    const v = String(value ?? '').trim();
    if (/[\r\n]/.test(v)) {
      throw new SettingsError(400, `${key} 不能包含換行。請確認貼上的內容正確。`);
    }
    clean[key] = v;
  }

  if (Object.keys(clean).length === 0) {
    throw new SettingsError(400, '沒有可更新的設定項目。');
  }

  let lines = [];
  try {
    lines = fs.readFileSync(envPath, 'utf8').split('\n');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    lines = ['# 由設定頁面建立。此檔案已列在 .gitignore，不會被 commit。'];
  }

  const seen = new Set();
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!m || !(m[1] in clean)) return line;
    seen.add(m[1]);
    return `${m[1]}=${clean[m[1]]}`;
  });

  // 先去掉結尾空行，再追加新變數 —— 否則新的一行會被原本檔尾的空行隔開
  while (next.length && next[next.length - 1].trim() === '') next.pop();

  for (const [key, value] of Object.entries(clean)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  // 權限設成只有擁有者能讀寫，避免同機其他使用者讀到金鑰
  fs.writeFileSync(envPath, next.join('\n') + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // Windows／WSL 的某些檔案系統不支援，忽略
  }

  // 立刻套用到目前的 process，不用重啟伺服器
  for (const [key, value] of Object.entries(clean)) {
    if (value) process.env[key] = value;
    else delete process.env[key];
  }

  return Object.keys(clean);
}
