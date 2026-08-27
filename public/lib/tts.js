// speechSynthesis 包一層。
// 經典雷：getVoices() 第一次呼叫常常回空陣列，voice 清單是非同步載入的。
// 同時監聽 voiceschanged 並做 polling 重試，兩邊誰先到就用誰。

let cached = null;

export function loadVoices(timeoutMs = 2000) {
  if (cached?.length) return Promise.resolve(cached);

  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve([]);

    const immediate = speechSynthesis.getVoices();
    if (immediate.length) {
      cached = immediate;
      return resolve(immediate);
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(pollId);
      speechSynthesis.removeEventListener('voiceschanged', finish);
      cached = speechSynthesis.getVoices();
      resolve(cached);
    };

    speechSynthesis.addEventListener('voiceschanged', finish);
    const deadline = Date.now() + timeoutMs;
    const pollId = setInterval(() => {
      if (speechSynthesis.getVoices().length || Date.now() > deadline) finish();
    }, 100);
  });
}

export function isSupported() {
  return 'speechSynthesis' in window;
}

/**
 * 唸出一段英文。
 * @returns {Promise<void>} 唸完才 resolve；失敗時 reject 帶中文訊息
 */
export async function speak(text, { rate = 0.9 } = {}) {
  if (!isSupported()) {
    throw new Error('這個瀏覽器不支援語音合成，無法播放示範發音。建議改用 Chrome 或 Edge。');
  }

  speechSynthesis.cancel();
  const voices = await loadVoices();

  if (voices.length === 0) {
    throw new Error('瀏覽器還沒載入任何語音，請稍等一下再試。若一直沒有，請確認系統已安裝語音包。');
  }
  const english = voices.filter((v) => v.lang?.startsWith('en'));
  if (english.length === 0) {
    throw new Error('系統裡找不到英語語音，請到作業系統的語音設定安裝英語語音包。');
  }

  const voice = english.find((v) => v.lang === 'en-US') ?? english[0];

  return new Promise((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = rate;
    u.onend = () => resolve();
    u.onerror = (e) => {
      // 使用者自己中斷不算錯誤
      if (e.error === 'interrupted' || e.error === 'canceled') return resolve();
      reject(new Error(`播放失敗（${e.error}），請再試一次。`));
    };
    speechSynthesis.speak(u);
  });
}

export function stop() {
  if (isSupported()) speechSynthesis.cancel();
}
