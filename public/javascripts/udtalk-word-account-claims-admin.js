(() => {
  document.querySelectorAll('.recovery-mail-form').forEach(form => {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = form.querySelector('button');
      const status = form.querySelector('[role="status"]');
      if (button.disabled) return;
      button.disabled = true;
      status.textContent = '';
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)),
        });
        const result = await response.json();
        if (!response.ok || !result.sent) throw new Error(result.error || form.dataset.error);
        button.textContent = form.dataset.resend;
        status.textContent = form.dataset.sent;
      } catch (error) {
        status.textContent = error.message || form.dataset.error;
      } finally {
        button.disabled = false;
      }
    });
  });
  document.querySelectorAll('[data-claim-dialog]').forEach(button => {
    const dialog = document.getElementById(button.dataset.claimDialog);
    if (!dialog) return;
    const image = dialog.querySelector('[data-src]');
    const imageError = dialog.querySelector('[data-image-error]');

    image.addEventListener('load', () => {
      image.hidden = false;
      imageError.hidden = true;
    });
    image.addEventListener('error', () => {
      image.hidden = true;
      imageError.hidden = false;
    });
    button.addEventListener('click', () => {
      dialog.showModal();
      dialog.scrollTop = 0;
      document.body.classList.add('claim-dialog-open');
      // 画像は詳細を開いた申請だけ取得する。取得失敗時は開き直して再試行できる。
      if (!image.hasAttribute('src') || !imageError.hidden) {
        imageError.hidden = true;
        image.src = image.dataset.src;
      }
    });
    dialog.querySelector('[data-close-dialog]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      document.body.classList.remove('claim-dialog-open');
      button.focus();
    });
  });
})();
