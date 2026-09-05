// 練習區怎麼分欄。
//
// **規則只有一條：主欄放「現在要動手的那一件事」，其餘全部進輔助欄。**
// 題目、作答、回饋是主欄；今天的進度、練習紀錄、參考資料（原文、情境說明、
// 這一級的進度）是輔助欄。分不出來的時候問一句：「這個東西在我作答的當下
// 需要嗎？」需要就是主欄。
//
// 為什麼要有這個模組而不是各模式自己排：寬螢幕上輔助欄是**常駐**的
// （sticky，捲主欄時不動），窄螢幕上它就接在主欄後面 —— 這兩種行為的切換
// 全在 CSS 的 `.view--split` 裡，六個模式各寫一次就會有人漏掉一種螢幕寬度。
//
// 模式不必知道自己被排在哪裡，只要把卡片交給 `main` 或 `side`。

import { h, clear } from './dom.js';

/**
 * 把 #view 分成主欄與輔助欄，回傳兩個空的容器。
 *
 * **每次 render 都要重新呼叫**（它會先清空 root）—— 沿用上一次的容器就會
 * 遇到「卡片還在、但事件監聽器指向已經被換掉的狀態」那一類 bug。
 *
 * @param {HTMLElement} root 模式拿到的容器（就是 #view）
 * @returns {{main: HTMLElement, side: HTMLElement}}
 */
export function columns(root) {
  clear(root);
  root.classList.add('view--split');

  const main = h('div', { class: 'view__main' });
  // <aside>：這一欄是「補充內容」，不是主要流程。螢幕閱讀器據此可以跳過
  const side = h('aside', { class: 'view__aside' });
  root.append(main, side);

  return { main, side };
}

/**
 * 這一畫面不分欄（例如單字卡的選難度：它自己就是一整頁的清單）。
 *
 * **切回單欄一定要走這裡**，不能只是 `clear(root)` —— `.view--split` 留在
 * root 上的話，下一個畫面只會用到左邊那一欄，右邊空著一大塊。
 */
export function single(root) {
  clear(root);
  root.classList.remove('view--split');
  return root;
}
