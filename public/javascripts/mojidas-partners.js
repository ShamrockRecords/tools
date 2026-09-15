'use strict';
// 招待トークンはURL fragmentからフォームへ移し、アクセスログとRefererに残さない。
const id = document.getElementById('invite-id');
const token = document.getElementById('invite-token');
if (id && token) {
  const fields = new URLSearchParams(location.hash.slice(1));
  id.value = fields.get('id') || '';
  token.value = fields.get('token') || '';
  history.replaceState(null, '', location.pathname);
}
