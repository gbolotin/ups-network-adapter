(function() {
  function injectKioskButton() {
    if (document.getElementById('ups-kiosk-nav-btn')) return;
    const refreshBtn = document.querySelector('button[title*="Refresh"]');
    if (!refreshBtn) return;
    const container = refreshBtn.closest('.flex.items-center.space-x-2') || refreshBtn.parentElement.parentElement;
    if (!container) return;

    const btn = document.createElement('a');
    btn.id = 'ups-kiosk-nav-btn';
    btn.href = window.location.protocol + '//' + (window.location.hostname || '127.0.0.1') + '/kiosk';
    btn.title = 'System Info & Controls';
    btn.className = 'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 h-9 px-3 border border-border-card shadow-none cursor-pointer';
    btn.style.textDecoration = 'none';
    btn.style.marginRight = '8px';
    btn.innerHTML = '<svg stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" class="size-4" height="1em" width="1em" xmlns="http://www.w3.org/2000/svg"><rect width="18" height="12" x="3" y="4" rx="2"/><line x1="2" x2="22" y1="20" y2="20"/><line x1="12" x2="12" y1="16" y2="20"/></svg><span style="font-size:14px; font-weight:600;">System Info</span>';
    container.insertBefore(btn, container.firstChild);
  }

  // Inject once DOM is ready and observe future Next.js client-side re-renders
  injectKioskButton();
  const observer = new MutationObserver(injectKioskButton);
  if (document.body) {
    observer.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      injectKioskButton();
      observer.observe(document.body, { childList: true, subtree: true });
    });
  }
})();
