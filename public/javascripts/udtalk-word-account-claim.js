(() => {
  const form = document.getElementById('claim-form');
  if (!form) return;
  const email = document.getElementById('email');
  const confirmation = document.getElementById('email-confirmation');
  const screenshot = document.getElementById('screenshot');
  const preview = document.getElementById('screenshot-preview');
  const submit = document.getElementById('submit-button');
  const status = document.getElementById('submit-status');
  const originalLabel = submit.textContent;
  let imageURL;
  function checkEmail() {
    confirmation.setCustomValidity(confirmation.value && email.value.trim() !== confirmation.value.trim()
      ? form.dataset.emailMismatch : '');
  }
  email.addEventListener('input', checkEmail);
  confirmation.addEventListener('input', checkEmail);
  screenshot.addEventListener('change', () => {
    if (imageURL) URL.revokeObjectURL(imageURL);
    preview.hidden = true;
    preview.removeAttribute('src');
    const file = screenshot.files[0];
    screenshot.setCustomValidity(file && file.size > 5 * 1024 * 1024 ? form.dataset.imageSize : '');
    if (file && screenshot.validity.valid) {
      imageURL = URL.createObjectURL(file);
      preview.src = imageURL;
      preview.hidden = false;
    }
  });
  form.addEventListener('submit', event => {
    checkEmail();
    if (!form.reportValidity()) {
      event.preventDefault();
      return;
    }
    submit.disabled = true;
    submit.textContent = form.dataset.submitting;
    status.textContent = form.dataset.submitting;
  });
  window.addEventListener('pageshow', () => {
    submit.disabled = false;
    submit.textContent = originalLabel;
    status.textContent = '';
    checkEmail();
  });
  document.getElementById('server-error')?.focus();
})();
