'use strict';
document.addEventListener('click', event => {
  const open = event.target.closest('[data-dialog-open]');
  if (open) document.getElementById(open.dataset.dialogOpen).showModal();
  const close = event.target.closest('[data-dialog-close]');
  if (close) close.closest('dialog').close();
});

let submitting = false;
document.addEventListener('submit', async event => {
  const form = event.target;
  const main = form.closest('main[data-admin-dynamic], main[data-partner-dynamic]');
  if (!main) return;
  event.preventDefault();
  if (submitting) return;
  submitting = true;
  const fields = new URLSearchParams(new FormData(form));
  const url = new URL(form.action, location.href);
  const method = form.method.toUpperCase();
  const month = new URL(location.href).searchParams.get('month');
  if (method === 'GET') url.search = fields.toString();
  else if (month) url.searchParams.set('month', month);
  const buttons = [...main.querySelectorAll('button')];
  const disabled = buttons.map(button => button.disabled);
  buttons.forEach(button => { button.disabled = true; });
  form.setAttribute('aria-busy', 'true');
  form.querySelector('[data-operation-error]')?.remove();
  try {
    const response = await fetch(url, { method, credentials: 'same-origin',
      headers: { 'X-Requested-With': 'MojidasDOM' },
      ...(method === 'POST' ? { body: fields } : {}) });
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    const updated = page.querySelector(main.hasAttribute('data-admin-dynamic')
      ? 'main[data-admin-dynamic]' : 'main[data-partner-dynamic]');
    if (!response.ok || !updated) {
      throw new Error(page.querySelector('[role="alert"]')?.textContent
        || '更新できませんでした。ログイン状態を確認して、もう一度お試しください。');
    }
    const scrollPosition = window.scrollY;
    main.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    main.replaceWith(updated);
    if (method === 'GET') history.replaceState(null, '', url.pathname + url.search);
    else if (/\/partners\/(login|logout|accept)$/.test(url.pathname)) history.replaceState(null, '', '/partners');
    window.scrollTo(0, scrollPosition);
    const notice = document.createElement('p');
    notice.setAttribute('role', 'status');
    notice.textContent = method === 'GET' ? '表示を更新しました。' : '処理が完了しました。';
    updated.querySelector('header').after(notice);
  } catch (error) {
    const notice = document.createElement('p');
    notice.dataset.operationError = '';
    notice.setAttribute('role', 'alert');
    notice.textContent = error.message || '通信に失敗しました。もう一度お試しください。';
    form.append(notice);
  } finally {
    buttons.forEach((button, index) => { button.disabled = disabled[index]; });
    form.removeAttribute('aria-busy');
    submitting = false;
  }
});
// 招待トークンはURL fragmentからフォームへ移し、アクセスログとRefererに残さない。
const id = document.getElementById('invite-id');
const token = document.getElementById('invite-token');
if (id && token) {
  const fields = new URLSearchParams(location.hash.slice(1));
  id.value = fields.get('id') || '';
  token.value = fields.get('token') || '';
  history.replaceState(null, '', location.pathname);
}
