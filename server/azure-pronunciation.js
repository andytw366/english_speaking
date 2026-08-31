import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

// Azure Speech 發音評估。
// 已對照 microsoft-cognitiveservices-speech-sdk@1.51.0 的型別定義確認：
//   - 預設輸入格式就是 16 kHz / 16-bit / 單聲道 PCM，
//     正好是 public/wav-encoder.js 產出的格式，音訊管線一個 byte 都不用改
//   - AudioConfig.fromWavFileInput(Buffer) 在 Node 可用（實測過），
//     所以金鑰可以留在伺服器端，不用送到瀏覽器
//   - PronunciationAssessmentResult 提供 accuracy / fluency / completeness /
//     prosody / pronunciation 五個分數，另有逐字與逐音素明細

const TIMEOUT_MS = 30_000;

// Prosody（語調／重音／節奏）目前只支援 en-US。
const LANGUAGE = 'en-US';

export class AzureError extends Error {
  constructor(code, httpStatus, userMessage, cause) {
    super(userMessage);
    this.name = 'AzureError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

export function hasAzureConfig() {
  return Boolean(
    process.env.AZURE_SPEECH_KEY?.trim() && process.env.AZURE_SPEECH_REGION?.trim()
  );
}

/**
 * 對一段錄音做發音評估。
 * @param {{ audioBuffer: Buffer, referenceText: string }} args
 */
export async function assessPronunciation({ audioBuffer, referenceText }) {
  if (!hasAzureConfig()) {
    throw new AzureError(
      'missing_azure_config',
      500,
      '伺服器沒有設定 Azure Speech 金鑰。請在 .env 填入 AZURE_SPEECH_KEY 與 ' +
        'AZURE_SPEECH_REGION（例如 eastasia），然後重新啟動伺服器。'
    );
  }

  const speechConfig = sdk.SpeechConfig.fromSubscription(
    process.env.AZURE_SPEECH_KEY.trim(),
    process.env.AZURE_SPEECH_REGION.trim()
  );
  speechConfig.speechRecognitionLanguage = LANGUAGE;

  const audioConfig = sdk.AudioConfig.fromWavFileInput(audioBuffer, 'recording.wav');

  const paConfig = new sdk.PronunciationAssessmentConfig(
    referenceText,
    sdk.PronunciationAssessmentGradingSystem.HundredMark,
    sdk.PronunciationAssessmentGranularity.Phoneme,
    // enableMiscue：偵測漏字與多唸的字（會影響 completeness 與 ErrorType）
    true
  );
  paConfig.enableProsodyAssessment = true;
  paConfig.phonemeAlphabet = 'IPA';

  const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
  paConfig.applyTo(recognizer);

  try {
    const result = await recognizeOnce(recognizer);
    return toPlainResult(result, referenceText);
  } finally {
    recognizer.close();
  }
}

function recognizeOnce(recognizer) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new AzureError(
          'timeout',
          504,
          `Azure 發音評估超過 ${TIMEOUT_MS / 1000} 秒沒有回應，請再試一次。`
        )
      );
    }, TIMEOUT_MS);

    recognizer.recognizeOnceAsync(
      (result) => {
        clearTimeout(timer);
        try {
          resolve(checkResult(result));
        } catch (err) {
          reject(err);
        }
      },
      (err) => {
        clearTimeout(timer);
        console.error('[azure] recognizeOnceAsync 失敗：', err);
        reject(
          new AzureError(
            'sdk_error',
            500,
            '呼叫 Azure 發音評估時發生錯誤，詳細原因請看伺服器 console。',
            err
          )
        );
      }
    );
  });
}

function checkResult(result) {
  if (result.reason === sdk.ResultReason.RecognizedSpeech) return result;

  if (result.reason === sdk.ResultReason.NoMatch) {
    throw new AzureError(
      'no_match',
      422,
      'Azure 在這段錄音裡聽不到清楚的英語。請確認麥克風有收到聲音、' +
        '環境不要太吵，然後大聲一點重錄一次。'
    );
  }

  if (result.reason === sdk.ResultReason.Canceled) {
    const details = sdk.CancellationDetails.fromResult(result);
    // 完整錯誤只留在伺服器端
    console.error(
      '[azure] 取消：',
      'reason=', details.reason,
      'errorCode=', details.ErrorCode,
      'details=', details.errorDetails
    );
    throw mapCancellation(details);
  }

  throw new AzureError(
    'unexpected_reason',
    500,
    `Azure 回了非預期的結果（reason=${result.reason}），請再試一次。`
  );
}

function mapCancellation(details) {
  switch (details.ErrorCode) {
    case sdk.CancellationErrorCode.AuthenticationFailure:
      return new AzureError(
        'invalid_credentials',
        401,
        'Azure Speech 金鑰或區域不正確。請確認 .env 裡的 AZURE_SPEECH_KEY 與 ' +
          'AZURE_SPEECH_REGION 都對（區域要跟你在 Azure 入口網站建立資源時選的一致，' +
          '例如 eastasia、japaneast），改完要重新啟動伺服器。'
      );
    case sdk.CancellationErrorCode.Forbidden:
      return new AzureError(
        'forbidden',
        403,
        'Azure 拒絕了這個請求。常見原因是免費層額度已用完，' +
          '或這個金鑰沒有語音服務的權限。請到 Azure 入口網站確認資源狀態與用量。'
      );
    case sdk.CancellationErrorCode.TooManyRequests:
      return new AzureError(
        'rate_limited',
        429,
        'Azure 請求太頻繁（免費層的併發數很低）。請等幾秒再試一次。'
      );
    case sdk.CancellationErrorCode.BadRequestParameters:
      return new AzureError(
        'bad_request',
        400,
        'Azure 不接受這個請求的參數或音檔。請重新錄一次；' +
          '若持續發生，請看伺服器 console 的完整錯誤。'
      );
    case sdk.CancellationErrorCode.ConnectionFailure:
      return new AzureError(
        'network',
        502,
        '連不到 Azure 語音服務，請確認這台機器可以連上網路後再試一次。'
      );
    case sdk.CancellationErrorCode.ServiceTimeout:
      return new AzureError('timeout', 504, 'Azure 語音服務回應逾時，請再試一次。');
    case sdk.CancellationErrorCode.ServiceError:
      return new AzureError(
        'service_error',
        502,
        'Azure 語音服務暫時有問題，請稍後再試一次。'
      );
    default:
      return new AzureError(
        'canceled',
        500,
        'Azure 中止了這次評估，詳細原因請看伺服器 console。'
      );
  }
}

/**
 * 把 SDK 的結果攤平成前端好用的形狀。
 * 注意：SDK 的 TypeScript 型別對音素層寫得不完整（沒宣告 AccuracyScore），
 * 但實際 JSON 是有的，所以這裡用防禦性讀取，讀不到就給 null。
 */
function toPlainResult(result, referenceText) {
  const pa = sdk.PronunciationAssessmentResult.fromResult(result);
  const detail = safeDetail(pa);

  const words = (detail?.Words ?? []).map((w) => ({
    word: w.Word ?? '',
    accuracy: numOrNull(w.PronunciationAssessment?.AccuracyScore),
    // None / Mispronunciation / Omission / Insertion / UnexpectedBreak / MissingBreak / Monotone
    errorType: w.PronunciationAssessment?.ErrorType ?? 'None',
    phonemes: (w.Phonemes ?? []).map((p) => ({
      phoneme: p.Phoneme ?? '',
      accuracy: numOrNull(p.PronunciationAssessment?.AccuracyScore),
    })),
  }));

  return {
    provider: 'azure',
    referenceText,
    recognizedText: result.text ?? '',
    scores: {
      pronunciation: numOrNull(pa.pronunciationScore),
      accuracy: numOrNull(pa.accuracyScore),
      fluency: numOrNull(pa.fluencyScore),
      completeness: numOrNull(pa.completenessScore),
      prosody: numOrNull(pa.prosodyScore),
    },
    words,
  };
}

function safeDetail(pa) {
  try {
    return pa.detailResult;
  } catch (err) {
    console.error('[azure] 解析 detailResult 失敗：', err);
    return null;
  }
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
