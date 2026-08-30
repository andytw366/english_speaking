// 示範發音（speechSynthesis）。
//
// 踩雷清單 #3：getVoices() 第一次呼叫常常回空陣列，voice 清單是非同步載入的。
// 同時監聽 voiceschanged 並做 polling 重試，兩邊誰先到就用誰。

/** 讀 voice 清單。逾時就回目前拿得到的（可能是空的），由呼叫端決定怎麼提示。 */
export function loadVoices(timeoutMs = 2000) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve([]);

    const immediate = speechSynthesis.getVoices();
    if (immediate.length) return resolve(immediate);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(pollId);
      speechSynthesis.removeEventListener('voiceschanged', finish);
      resolve(speechSynthesis.getVoices());
    };

    speechSynthesis.addEventListener('voiceschanged', finish);

    const deadline = Date.now() + timeoutMs;
    const pollId = setInterval(() => {
      if (speechSynthesis.getVoices().length || Date.now() > deadline) finish();
    }, 100);
  });
}

/**
 * 唸一句英文。
 *
 * 失敗一律回傳「要給使用者看的中文訊息」而不是丟例外 ——
 * 這裡每一種失敗都有對應的處理方式（裝語音包、等一下再按），
 * 丟一個 Error 出去只會變成畫面上的 error code。
 *
 * @param {string} text
 * @param {{rate?: number, onError?: (message: string) => void}} [options]
 *        onError 是「已經開始播放之後才失敗」的通知（回傳值那時已經給出去了）
 * @returns {Promise<string|null>} null 代表已開始播放
 */
export async function speak(text, { rate = 0.9, onError } = {}) {
  if (!('speechSynthesis' in window)) {
    return '這個瀏覽器不支援語音合成，無法播放示範發音。建議改用 Chrome 或 Edge。';
  }
  if (!text) return null;

  speechSynthesis.cancel();
  const voices = await loadVoices();

  if (voices.length === 0) {
    return '瀏覽器還沒載入任何語音，請稍等一下再按一次。若一直沒有，請確認系統已安裝語音包。';
  }

  const englishVoices = voices.filter((v) => v.lang?.startsWith('en'));
  if (englishVoices.length === 0) {
    return '系統裡找不到英語語音，請到作業系統的語音設定安裝英語語音包。';
  }

  // 優先挑 en-US，其次任何英語語音
  const voice = englishVoices.find((v) => v.lang === 'en-US') ?? englishVoices[0];

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = rate;
  utterance.onerror = (e) => {
    // 使用者自己按了下一句造成的中斷不是錯誤，不要跳提示
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    onError?.(`播放示範發音失敗（${e.error}），請再試一次。`);
  };
  speechSynthesis.speak(utterance);
  return null;
}
