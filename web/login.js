(function () {
  const form = document.getElementById('login');
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button');
    const error = document.getElementById('error');
    button.disabled = true;
    error.textContent = '';
    try {
      const response = await fetch(form.dataset.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: form.username.value, password: form.password.value }),
      });
      let body = {};
      try { body = await response.json(); } catch { /* 错误正文可能不是 JSON */ }
      if (!response.ok) throw new Error(body.error || '登录失败');
      location.assign(form.dataset.next);
    } catch (err) {
      error.textContent = err.message || '登录失败';
      button.disabled = false;
      form.password.focus();
    }
  });
})();
