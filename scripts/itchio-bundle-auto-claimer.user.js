// ==UserScript==
// @name         Itch.io Bundle Auto-Claimer (with progress bar)
// @version      2.2
// @match        https://itch.io/bundle/download/*
// @grant        none
// ==/UserScript==

(function () {
  const DELAY_MS = 1200;

  const STORAGE_KEY = 'itchBundleClaimCount';
  function getCount() {
    return parseInt(sessionStorage.getItem(STORAGE_KEY) || '0', 10);
  }
  function bumpCount() {
    const n = getCount() + 1;
    sessionStorage.setItem(STORAGE_KEY, n);
    return n;
  }

  const bar = document.createElement('div');
  bar.style.cssText = `
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 99999;
    background: #222; color: #fff; font: 13px sans-serif;
    padding: 8px 14px; display: flex; justify-content: space-between;
    box-shadow: 0 -2px 6px rgba(0,0,0,0.3);
  `;
  bar.innerHTML = `<span id="claimer-status">Starting…</span><span id="claimer-count">Claimed so far: ${getCount()}</span>`;
  document.body.appendChild(bar);

  function setStatus(text) {
    const el = document.getElementById('claimer-status');
    if (el) el.textContent = text;
  }
  function refreshCount() {
    const el = document.getElementById('claimer-count');
    if (el) el.textContent = `Claimed so far: ${getCount()}`;
  }

  async function claimForm(form) {
    const claimBtn = form.querySelector('button[value="claim"]');
    const formData = new FormData(form);
    if (claimBtn) {
      formData.set(claimBtn.name || 'action', claimBtn.value || 'claim');
    }
    const body = new URLSearchParams(formData);

    try {
      // FIX: form.action is unreliable here because a field is named "action"
      // (it shadows the real action property) — just post to the current page.
      const res = await fetch(window.location.href, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body,
      });

      if (res.ok) {
        bumpCount();
        refreshCount();
        const row = form.closest('.game_row');
        if (row) row.style.opacity = '0.4';
        return true;
      } else {
        const text = await res.text().catch(() => '');
        console.warn('Claim failed:', res.status, form, text.slice(0, 300));
        return false;
      }
    } catch (err) {
      console.warn('Claim request errored:', err, form);
      return false;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function processPage() {
    const claimForms = Array.from(document.querySelectorAll('form')).filter(
      (f) => f.querySelector('button[value="claim"]')
    );

    setStatus(`Found ${claimForms.length} unclaimed item(s) on this page…`);

    let failures = 0;
    for (let i = 0; i < claimForms.length; i++) {
      setStatus(`Claiming item ${i + 1} of ${claimForms.length}…`);
      const ok = await claimForm(claimForms[i]);
      if (!ok) failures++;
      await sleep(DELAY_MS);
    }

    setStatus(
      failures > 0
        ? `Page done (${failures} failed — check console). Moving on…`
        : 'Page done. Checking for next page…'
    );

    const nextPage = document.querySelector('a.next_page.button:not(.disabled)');
    if (nextPage) {
      await sleep(500);
      window.location.href = nextPage.href;
    } else {
      setStatus(`All done! Total claimed this session: ${getCount()}`);
    }
  }

  window.addEventListener('load', () => {
    refreshCount();
    setTimeout(processPage, 800);
  });
})();
