// 登入／建立第一個帳號的畫面。
//
// 這不是一個「模式」—— 模式是登入之後才有的東西，而且模式列本身在沒登入時
// 應該整個看不到。所以它由 `app.js` 直接畫進 `#view`，並且在 `<body>` 加一個
// `locked` 類別把側欄、下方模式列與齒輪藏起來。

import { h, clear, append } from './dom.js';
import { login, register } from './session.js';

/**
 * @param {HTMLElement} root 畫在哪
 * @param {{firstRun: boolean, canRegister: boolean, onDone: Function}} options
 *   `firstRun` = 伺服器一個帳號都還沒有 → 這一次是「建立擁有者帳號」
 */
export function renderLogin(root, { firstRun, canRegister, onDone }) {
  // 沒有帳號時只能註冊；有帳號但開了邀請碼時兩種都可以
  let mode = firstRun ? 'register' : 'login';
  let busy = false;
  let message = '';
  // 每次重畫都是整個重建 DOM，所以欄位的值要自己留著 ——
  // 不留的話，密碼打錯一次就得連帳號一起重打
  let username = '';
  let invite = '';

  function draw() {
    clear(root);
    const registering = mode === 'register';

    const form = h('form', {
      class: 'card login',
      onsubmit: (e) => { e.preventDefault(); submit(); },
    },
      h('p', { class: 'card__title' }, registering
        ? (firstRun ? '建立第一個帳號' : '建立新帳號')
        : '登入'),

      h('p', { class: 'hint' }, registering && firstRun
        ? '這台伺服器還沒有任何帳號。你建立的第一個就是擁有者 —— ' +
          '之後預設不再開放註冊，要再開一個得在伺服器的 .env 設定 INVITE_CODE。'
        : '學習進度存在這台伺服器上，登入之後手機與電腦看到的是同一份。'),

      field('帳號', h('input', {
        class: 'field__input', id: 'login-username', name: 'username',
        type: 'text', autocomplete: 'username', required: 'required',
        // 密碼管理程式要靠這個把帳號跟密碼配成一組
        autocapitalize: 'none', spellcheck: 'false',
        value: username,
        oninput: (e) => { username = e.target.value; },
      })),

      field('密碼', h('input', {
        class: 'field__input', id: 'login-password', name: 'password',
        type: 'password', required: 'required',
        autocomplete: registering ? 'new-password' : 'current-password',
      })),

      registering && !firstRun && field('邀請碼', h('input', {
        class: 'field__input', id: 'login-invite', name: 'invite', type: 'text',
        value: invite,
        oninput: (e) => { invite = e.target.value; },
      })),

      // h() 用 textContent，markdown 的星號會原樣印出來 —— 要粗體就得多一個元素
      registering && h('p', { class: 'hint' },
        '密碼至少 8 個字元。',
        h('strong', {}, '沒有密碼重設功能'),
        ' —— 忘記的話要到伺服器上改 users.json。'),

      h('div', { class: 'row' },
        h('button', { class: 'btn btn--primary', type: 'submit', disabled: busy },
          busy ? '處理中…' : (registering ? '建立帳號' : '登入')),

        // 一個帳號都沒有時不給切換 —— 那時候根本沒有東西可以登入
        !firstRun && canRegister && h('button', {
          class: 'btn btn--ghost', type: 'button', disabled: busy,
          onclick: () => { mode = registering ? 'login' : 'register'; message = ''; draw(); },
        }, registering ? '我已經有帳號了' : '用邀請碼建立帳號'),
      ),

      message && h('p', { class: 'hint hint--warn' }, message),
    );

    append(root, form);
    root.querySelector('#login-username')?.focus();
  }

  async function submit() {
    username = root.querySelector('#login-username')?.value.trim() ?? '';
    invite = root.querySelector('#login-invite')?.value.trim() ?? '';
    const password = root.querySelector('#login-password')?.value ?? '';

    busy = true;
    message = '';
    draw();

    try {
      const user = mode === 'register'
        ? await register(username, password, invite)
        : await login(username, password);
      onDone(user);
    } catch (err) {
      busy = false;
      message = err.message ?? '登入失敗，請再試一次。';
      draw();
      // 重畫之後焦點回到密碼欄：失敗幾乎都是密碼打錯，帳號不用重打
      const pw = root.querySelector('#login-password');
      if (pw) { pw.value = password; pw.focus(); pw.select(); }
    }
  }

  draw();
}

function field(label, input) {
  return h('div', { class: 'field' },
    h('label', { class: 'field__label', for: input.id }, label),
    input,
  );
}
