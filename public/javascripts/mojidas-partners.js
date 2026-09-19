'use strict';
function nextValidityMonth(value) {
  const date = new Date(value + ':00Z');
  if (!Number.isFinite(date.getTime())) return '';
  const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + 1);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString().slice(0, 16);
}
function updateValidity(form) {
  const fields = form.querySelector('[data-validity-fields]');
  const enabled = form.elements.validityPeriod.value === 'limited';
  fields.hidden = !enabled; fields.disabled = !enabled;
  if (enabled && !form.elements.validityStartsAt.value) {
    form.elements.validityStartsAt.value = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16);
    form.elements.validityEndsAt.value = nextValidityMonth(form.elements.validityStartsAt.value);
  }
}
function updateAnnualOrganization(main, value) {
  const select = main.querySelector('[data-annual-organization]');
  if (!select) return;
  select.value = value;
  // 削除などで選択肢がなくなった場合も未選択へ戻す。
  if (!select.value) select.value = '';
  main.querySelectorAll('[data-annual-domain]').forEach(row => {
    row.hidden = !select.value || row.dataset.annualDomain !== select.value;
  });
  main.querySelector('[data-annual-empty]').hidden = !!select.value;
}
document.addEventListener('change', event => {
  if (event.target.matches('[data-validity-toggle]')) updateValidity(event.target.form);
  if (event.target.matches('[data-validity-start]')) event.target.form.elements.validityEndsAt.value = nextValidityMonth(event.target.value);
  if (event.target.matches('[data-auto-month]') && event.target.checkValidity()) {
    event.target.form.requestSubmit();
  }
  if (event.target.matches('[data-annual-organization]')) {
    updateAnnualOrganization(event.target.closest('main'), event.target.value);
  }
});
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
  if (form.hasAttribute('data-confirm-delete') && !window.confirm('この法人ドメインの登録情報を削除します。よろしいですか？')) return;
  submitting = true;
  const fields = new URLSearchParams(new FormData(form));
  const url = new URL(form.action, location.href);
  const method = form.method.toUpperCase();
  const month = new URL(location.href).searchParams.get('month');
  const year = new URL(location.href).searchParams.get('year');
  if (method === 'GET') url.search = fields.toString();
  else if (month) url.searchParams.set('month', month);
  if (year && !url.searchParams.has('year')) url.searchParams.set('year', year);
  const buttons = [...main.querySelectorAll('button, [data-auto-month]')];
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
    updateAnnualOrganization(updated, main.querySelector('[data-annual-organization]')?.value || '');
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
