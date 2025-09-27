/**
 * AppShell - shared header/nav + PWA bits for CardCue.
 */
class AppShell extends HTMLElement {
  connectedCallback() {
    if (this.__init) return;
    this.__init = true;

    // 1) Apply saved theme immediately so there’s no flash
    const savedTheme = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', savedTheme);

    const APP = window.APP || {};
    const brandTitle = APP.name || 'CardCue';
    const shortName  = APP.shortName || brandTitle;
    const themeColor = APP.themeColor || '#8b93ff';
    const bgColor    = APP.backgroundColor || '#0b0e14';
    const iconsPath  = APP.iconsPath || 'icons';

    const logoSrc    = this.getAttribute('data-logo') || `${iconsPath}/favicon-32x32.png`;
    const brandOffset = parseInt(this.getAttribute('data-brand-offset') || '0', 10);

    // ---------- Header / Nav ----------
    const header = document.createElement('header');
    header.className = 'app-header';
    header.innerHTML = `
      <div class="header-left">
        ${logoSrc ? `<img class="brand-logo" src="${logoSrc}" alt="" width="20" height="20" />` : ''}
        <h1 class="app-title">${brandTitle}</h1>
        <nav class="nav">
          <a class="nav-link" href="study.html">Study</a>
          <a class="nav-link" href="metrics.html">Metrics</a>
          <a class="nav-link" href="editor.html">Editor</a>
        </nav>
      </div>
      <div class="app-actions">
        <button id="btn-import" class="btn">Import</button>
        <input id="file-input" type="file" accept=".xlsx,.json" hidden multiple />
        <label class="switch" title="Replace on import">
          <input id="chk-replace-import" type="checkbox" /> Replace
        </label>
        <span class="divider"></span>
        <button id="btn-export" class="btn">Export JSON</button>
        <button id="btn-template-xlsx" class="btn">Template</button>
        <button id="btn-export-xlsx" class="btn">Export XLSX</button>
        <button id="btn-reset" class="btn">Reset</button>
        <button id="btn-clear" class="btn">Clear</button>
        <span class="divider"></span>
        <button id="btn-theme" class="btn ghost" title="Toggle theme"></button>
        <button id="btn-help" class="btn ghost" title="Shortcuts">?</button>
      </div>
    `;

    if (brandOffset) {
      const titleEl = header.querySelector('.app-title');
      if (titleEl) titleEl.style.marginLeft = brandOffset + 'px';
    }

    const main = document.createElement('div');
    main.className = 'app-shell-slot';
    while (this.firstChild) main.appendChild(this.firstChild);

    const footer = document.createElement('footer');
    footer.className = 'app-footer';
    footer.innerHTML = `<small>Data stays in your browser · Export to back up</small>`;

    this.append(header, main, footer);

    // Page title + meta
    const pageSuffix = this._inferPageSuffix();
    document.title = pageSuffix ? `${brandTitle} - ${pageSuffix}` : brandTitle;
    this._ensureMeta('apple-mobile-web-app-title', brandTitle);
    this._ensureMeta('theme-color', themeColor);

    // Dynamic manifest disabled — using static manifest.json from pages.

    // Highlight current nav
    const here = (location.pathname.split('/').pop() || 'study.html').toLowerCase();
    this.querySelectorAll('.nav-link').forEach(a => {
      if ((a.getAttribute('href') || '').toLowerCase() === here) {
        a.style.background = 'rgba(255,255,255,.15)';
      }
    });

    // ---------- Theme toggle ----------
    const themeBtn = this.querySelector('#btn-theme');
    const applyTheme = (mode) => {
      document.documentElement.setAttribute('data-theme', mode);
      localStorage.setItem('theme', mode);
      themeBtn.textContent = mode === 'dark' ? '☀️ Light' : '🌙 Dark';
      themeBtn.setAttribute('aria-pressed', String(mode === 'dark'));
    };
    applyTheme(savedTheme);
    themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      applyTheme(cur === 'light' ? 'dark' : 'light');
    });
    window.addEventListener('keydown', (e) => {
      if ((e.key || '').toLowerCase() === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const cur = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(cur === 'light' ? 'dark' : 'light');
      }
    });

    // ---------- Help ----------
    this.querySelector('#btn-help')?.addEventListener('click', () => {
      alert(
`Keyboard:
• Study session: A/B/C/D, J/K prev/next, F flip, G got, M missed, R repeat later
• Preview/Editor: J/K to move, Enter to toggle reveal
• Theme: T`
      );
    });

    // ---------- Import/Export bindings ----------
    if (window.App?.initImportExportBindings) {
      App.initImportExportBindings();
    } else {
      window.addEventListener('load', () => App?.initImportExportBindings?.());
    }

    // ---------- Service Worker (GitHub Pages-safe) ----------
    (function registerSW() {
      if (!('serviceWorker' in navigator)) return;

      const isSecure =
        window.isSecureContext ||
        location.protocol === 'https:' ||
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1';
      if (!isSecure) return;

      // Scope detection: "/<repo>/" on GitHub Pages, "/" locally
      const parts = location.pathname.split('/').filter(Boolean);
      const isPages = location.hostname.endsWith('github.io');
      const base = isPages ? `/${parts[0]}/` : '/';

      navigator.serviceWorker
        .register(`${base}service-worker.js`, { scope: base })
        .then(reg => {
          console.log('[SW] registered with scope', base);

          // Reload the page once when a new controller takes over
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (window.__reloadingForSW) return;
            window.__reloadingForSW = true;
            location.reload();
          });

          // Optional: log messages from SW (e.g., version activated)
          navigator.serviceWorker.addEventListener('message', (e) => {
            if (e.data?.type === 'SW_ACTIVATED') {
              console.log('[SW] Activated version:', e.data.version);
            }
          });

          return reg;
        })
        .catch(err => console.error('[SW] failed', err));
    })();
  }

  _ensureMeta(name, content) {
    let m = document.querySelector(`meta[name="${name}"]`);
    if (!m) { m = document.createElement('meta'); m.setAttribute('name', name); document.head.appendChild(m); }
    m.setAttribute('content', content);
  }

  _attachManifest(_obj) {
    // Dynamic manifest disabled — using static manifest.json from pages.
  }

  _inferPageSuffix() {
    const f = (location.pathname.split('/').pop() || '').toLowerCase();
    if (f.includes('metrics')) return 'Metrics';
    if (f.includes('editor'))  return 'Editor';
    if (f.includes('study'))   return 'Study';
    return '';
  }
}
customElements.define('app-shell', AppShell);
