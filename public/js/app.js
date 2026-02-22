(function () {
  const balanceEls = document.querySelectorAll('[data-balance]');
  async function refreshBalance() {
    if (!balanceEls.length) return;
    try {
      const res = await fetch('/api/balance');
      const data = await res.json();
      balanceEls.forEach((el) => {
        el.textContent = `\u20B9${Number(data.balance).toFixed(2)}`;
      });
    } catch (err) {}
  }
  refreshBalance();
  setInterval(refreshBalance, 30000);

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.querySelector(btn.dataset.copy);
      if (!target) return;
      navigator.clipboard.writeText(target.textContent || '').catch(() => {});
      btn.textContent = 'Copied';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
  });
})();
