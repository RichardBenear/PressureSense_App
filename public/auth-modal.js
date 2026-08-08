// Shared password gate for mutating actions (manual zone/program control,
// save schedule, schedules toggle). Pages themselves are public -- this is
// the only place a password is ever required. Not loaded on map.html, which
// has no mutating actions.
(function () {
  let modal = null;

  function ensureModal() {
    if (modal) return modal;

    const style = document.createElement('style');
    style.textContent = `
      .authm-backdrop { position: fixed; inset: 0; background: rgba(4,8,16,0.72); display: none; align-items: center; justify-content: center; z-index: 1000; padding: 24px; }
      .authm-card { width: 100%; max-width: 340px; background: #0e1a2b; border: 1px solid #1c3350; border-radius: 12px; padding: 28px 24px; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
      .authm-title { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 18px; letter-spacing: 1px; color: #e8f4fd; margin-bottom: 4px; }
      .authm-sub { font-family: 'Share Tech Mono', monospace; font-size: 11px; color: #5f7da0; letter-spacing: 1px; margin-bottom: 18px; }
      .authm-field input { width: 100%; box-sizing: border-box; background: #08111d; border: 1px solid #23405f; border-radius: 8px; color: #e8f4fd; font-family: 'Barlow', sans-serif; font-size: 16px; padding: 11px 13px; outline: none; }
      .authm-field input:focus { border-color: #0d6efd; }
      .authm-actions { display: flex; gap: 8px; margin-top: 14px; }
      .authm-btn { flex: 1; border: none; border-radius: 8px; font-family: 'Barlow Condensed', sans-serif; font-weight: 700; font-size: 15px; letter-spacing: 1px; padding: 11px; cursor: pointer; }
      .authm-btn-primary { background: #0d6efd; color: #fff; }
      .authm-btn-primary:hover { background: #2b7cff; }
      .authm-btn-primary:disabled { opacity: 0.6; cursor: default; }
      .authm-btn-ghost { background: transparent; color: #7f9cc0; border: 1px solid #23405f; }
      .authm-error { color: #ef4444; font-family: 'Share Tech Mono', monospace; font-size: 12px; text-align: center; min-height: 16px; margin-top: 12px; }
    `;
    document.head.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'authm-backdrop';
    backdrop.innerHTML = `
      <div class="authm-card">
        <div class="authm-title">Password required</div>
        <div class="authm-sub">THIS ACTION NEEDS THE DASHBOARD PASSWORD</div>
        <div class="authm-field">
          <input id="authm-pw" type="password" autocomplete="current-password" />
        </div>
        <div class="authm-actions">
          <button id="authm-cancel" class="authm-btn authm-btn-ghost" type="button">Cancel</button>
          <button id="authm-submit" class="authm-btn authm-btn-primary" type="button">Unlock</button>
        </div>
        <div id="authm-error" class="authm-error"></div>
      </div>
    `;
    document.body.appendChild(backdrop);
    modal = backdrop;
    return backdrop;
  }

  // Resolves once a valid password has been submitted (the session cookie is
  // now set); rejects with Error('cancelled') if the user backs out.
  function promptPassword() {
    return new Promise((resolve, reject) => {
      const el = ensureModal();
      const pw = el.querySelector('#authm-pw');
      const err = el.querySelector('#authm-error');
      const submitBtn = el.querySelector('#authm-submit');
      const cancelBtn = el.querySelector('#authm-cancel');

      pw.value = '';
      err.textContent = '';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Unlock';
      el.style.display = 'flex';
      pw.focus();

      function cleanup() {
        el.style.display = 'none';
        submitBtn.removeEventListener('click', onSubmit);
        cancelBtn.removeEventListener('click', onCancel);
        pw.removeEventListener('keydown', onKeydown);
        el.removeEventListener('mousedown', onBackdropClick);
      }

      async function onSubmit() {
        err.textContent = '';
        submitBtn.disabled = true;
        submitBtn.textContent = 'Checking…';
        try {
          const res = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw.value }),
          });
          if (res.ok) {
            cleanup();
            resolve();
            return;
          }
          err.textContent = res.status === 401 ? 'Incorrect password.' : 'Sign in failed. Try again.';
        } catch (e) {
          err.textContent = 'Network error. Check your connection.';
        }
        submitBtn.disabled = false;
        submitBtn.textContent = 'Unlock';
      }

      function onCancel() {
        cleanup();
        reject(new Error('cancelled'));
      }

      function onKeydown(e) {
        if (e.key === 'Enter') onSubmit();
        else if (e.key === 'Escape') onCancel();
      }

      function onBackdropClick(e) {
        if (e.target === el) onCancel();
      }

      submitBtn.addEventListener('click', onSubmit);
      cancelBtn.addEventListener('click', onCancel);
      pw.addEventListener('keydown', onKeydown);
      el.addEventListener('mousedown', onBackdropClick);
    });
  }

  function postCommand(cmd) {
    return fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
  }

  // Sends a mutating command; prompts for the password (once) if the session
  // has expired or was never established, then retries. Throws on failure
  // (including a plain Error('cancelled') if the user backs out of the
  // prompt) so callers can toast the reason.
  window.sendGatedCommand = async function sendGatedCommand(cmd) {
    let res = await postCommand(cmd);
    if (res.status === 401) {
      await promptPassword();
      res = await postCommand(cmd);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || 'Command failed');
    }
  };
})();
