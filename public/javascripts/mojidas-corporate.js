document.querySelectorAll('[data-auto-enable]').forEach(checkbox => {
  const form = checkbox.closest('form'), status = form.querySelector('[data-policy-status]');
  let saved = checkbox.checked;
  checkbox.addEventListener('change', async () => {
    checkbox.disabled = true;
    status.textContent = '保存中…';
    const body = new URLSearchParams(new FormData(form));
    body.set('mode', checkbox.checked ? 'auto' : 'manual');
    try {
      const response = await fetch(form.action, { method: 'POST', headers: { Accept: 'application/json' }, body });
      if (!response.ok) throw new Error('保存失敗');
      const result = await response.json();
      if (typeof result.autoEnable !== 'boolean') throw new Error('保存失敗');
      saved = result.autoEnable;
      status.textContent = '保存しました。';
    } catch (_) {
      status.textContent = '保存を確認できませんでした。再読み込みして設定を確認してください。';
    } finally {
      checkbox.checked = saved;
      checkbox.disabled = false;
    }
  });
});
