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

    const pageSuffix = this._inferPageSuffix();
    document.title = pageSuffix ? `${brandTitle} - ${pageSuffix}` : brandTitle;
    this._ensureMeta('apple-mobile-web-app-title', brandTitle);
    this._ensureMeta('theme-color', themeColor);

    this._attachManifest({
      name: brandTitle,
      short_name: shortName,
      theme_color: themeColor,
      background_color: bgColor,
      display: 'standalone',
      start_url: 'study.html',
      icons: [
        { src: `${iconsPath}/icon-192x192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: `${iconsPath}/icon-512x512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: `${iconsPath}/icon-192x192-maskable.png`, sizes: '192x192', type: 'image/png', purpose: 'maskable' },
        { src: `${iconsPath}/icon-512x512-maskable.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
      ]
    });

    const here = (location.pathname.split('/').pop() || 'study.html').toLowerCase();
    this.querySelectorAll('.nav-link').forEach(a => {
      if ((a.getAttribute('href') || '').toLowerCase() === here) {
        a.style.background = 'rgba(255,255,255,.15)';
      }
    });

    // ---------- NEW: clearer theme toggle ----------
    const themeBtn = this.querySelector('#btn-theme');

    const applyTheme = (mode) => {
      document.documentElement.setAttribute('data-theme', mode);
      localStorage.setItem('theme', mode);
      // Make it obvious with a label + emoji
      themeBtn.textContent = mode === 'dark' ? '☀️ Light' : '🌙 Dark';
      themeBtn.setAttribute('aria-pressed', String(mode === 'dark'));
    };

    // initial label
    applyTheme(savedTheme);

    // click to toggle
    themeBtn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      applyTheme(cur === 'light' ? 'dark' : 'light');
    });

    // keyboard shortcut: press "T" anywhere to toggle
    window.addEventListener('keydown', (e) => {
      if ((e.key || '').toLowerCase() === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const cur = document.documentElement.getAttribute('data-theme') || 'light';
        applyTheme(cur === 'light' ? 'dark' : 'light');
      }
    });
    // ---------- end theme block ----------

    this.querySelector('#btn-help')?.addEventListener('click', () => {
      alert(
`Keyboard:
• Study session: A/B/C/D, J/K prev/next, F flip, G got, M missed, R repeat later
• Preview/Editor: J/K to move, Enter to toggle reveal
• Theme: T`
      );
    });

    if (window.App?.initImportExportBindings) {
      App.initImportExportBindings();
    } else {
      window.addEventListener('load', () => App?.initImportExportBindings?.());
    }

    // SW (Pages is HTTPS, so this will run)
    if (
      'serviceWorker' in navigator &&
      (window.isSecureContext ||
        location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1')
    ) {
      navigator.serviceWorker
        .register('service-worker.js')
        .then(() => console.log('SW registered'))
        .catch(err => console.error('SW failed', err));
    }
  }

  _ensureMeta(name, content) {
    let m = document.querySelector(`meta[name="${name}"]`);
    if (!m) { m = document.createElement('meta'); m.setAttribute('name', name); document.head.appendChild(m); }
    m.setAttribute('content', content);
  }

  _attachManifest(obj) {
    // Dynamic manifest disabled — using static manifest.json from study.html
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
