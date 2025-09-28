/* app.js - Core logic for CardCue (client-only, no build)
   Features:
   - Import: .xlsx (Flashcards + MCQ sheets) and .json
   - Export: JSON + Excel (.xlsx) mirroring import format; Template .xlsx
   - Deck schema with per-card stats + spaced repetition
   - Filters (topic/type/search/wrong-only/due-only), shuffle
   - Session engine helpers for the study page
   - Settings: showExplanationByDefault, autoAdvanceOnCorrect, viewMode (persisted)
   - Global API for all pages via window.App
*/
(function () {
  'use strict';

  /**
   * Query selector helper.
   * @param {string} sel - CSS selector.
   * @returns {Element|null} The first matching element or null.
   */
  var $ = function (sel) { return document.querySelector(sel); };

  /**
   * Query selector-all helper returning an Array.
   * @param {string} sel - CSS selector.
   * @returns {Element[]} Array of matching elements.
   */
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /**
   * Current timestamp in ISO 8601 format.
   * @returns {string} ISO timestamp.
   */
  var nowISO = function () { return new Date().toISOString(); };

  /**
   * Current timestamp in milliseconds.
   * @returns {number} Milliseconds since epoch.
   */
  var nowMs = function () { return Date.now(); };

  /**
   * Generates a short unique identifier.
   * @returns {string} A random identifier.
   */
  function uid() { return Math.random().toString(36).slice(2, 10); }

  /**
   * Typesets maths using MathJax if available.
   * @param {HTMLElement} [container] - Optional container to limit typesetting.
   * @returns {Promise<void>} Resolves when typesetting completes.
   */
  function typesetMath(container) {
    if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
      try { window.MathJax.typesetClear && window.MathJax.typesetClear(); } catch (_e) {}
      return window.MathJax.typesetPromise(container ? [container] : undefined).catch(function (e) {
        console.error('MathJax typeset error:', e);
      });
    }
    return Promise.resolve();
  }

  /**
   * Escapes HTML special characters.
   * @param {string} s - Input string.
   * @returns {string} Escaped string safe for innerHTML.
   */
  function escapeHTML(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch];
    });
  }

  /**
   * Triggers a JSON file download.
   * @param {any} obj - Data to serialise.
   * @param {string} filename - Output filename.
   * @returns {void}
   */
  function downloadJSON(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /**
   * Triggers a file download from an ArrayBuffer/Uint8Array.
   * @param {string} name - Output filename.
   * @param {string} mime - MIME type.
   * @param {ArrayBuffer|Uint8Array} buffer - Data buffer.
   * @returns {void}
   */
  function downloadBlob(name, mime, buffer) {
    var blob = new Blob([buffer], { type: mime });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  /**
   * Returns a shuffled copy of an array using Fisher-Yates.
   * @param {any[]} arr - Input array.
   * @returns {any[]} Shuffled copy.
   */
  function fisherYates(arr) {
    var a = arr.slice(), i, j, t;
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /**
   * Safely invokes a function and ignores errors.
   * @param {Function} fn - Function to invoke.
   * @returns {void}
   */
  function safe(fn) { try { typeof fn === 'function' && fn(); } catch (_e) {} }

  // ---------- Settings (persisted) ----------

  // Namespace localStorage by path so dev/prod don't collide
  var APP_NS = (function () {
    try {
      // e.g. /cardcue/ or /cardcue-dev/ -> "cardcue" or "cardcue-dev"
      var first = location.pathname.split('/').filter(Boolean)[0] || 'cardcue';
      return 'cardcue:' + first;
    } catch (_) { return 'cardcue:default'; }
  })();

  // Primary storage keys
  var KEY          = APP_NS + ':deck:v1';
  var KEY_SESSIONS = APP_NS + ':sessions';

  // Keys
  var SETTINGS_KEY = APP_NS + ':settings';
  var VIEWMODE_KEY = APP_NS + ':viewmode';  // 'single' | 'grid' | etc.
  var THEME_KEY    = APP_NS + ':theme';     // 'light' | 'dark' (optional, for consistency)
  var META_KEY     = APP_NS + ':deckMeta';  // stores { name, importedAt }

  // Defaults for persisted settings
  var defaultSettings = {
    showExplanationByDefault: false,
    autoAdvanceOnCorrect:     false
  };

  // Load/save helpers for settings
  function loadSettings() {
    try {
      return Object.assign({}, defaultSettings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch (_e) {
      return Object.assign({}, defaultSettings);
    }
  }

  var __settings = loadSettings();

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(__settings)); } catch (_e) {}
  }

  // ---------- Storage + model ----------
  var SR_STEPS = [1, 3, 7, 14]; // days

  /** @type {{version:number,createdAt:string,updatedAt:string,cards:Array,topicIndex:Object}} */
  var deck = loadDeck();

  /**
   * Creates a new empty deck object.
   * @returns {{version:number,createdAt:string,updatedAt:string,cards:Array,topicIndex:Object}} Deck.
   */
  function newDeck() {
    return { version: 1, createdAt: nowISO(), updatedAt: nowISO(), cards: [], topicIndex: {} };
  }

  /**
   * Initialises per-card statistics structure.
   * @returns {{seen:number,correct:number,streak:number,lastSeen:string|null}} Stats.
   */
  function initStats() { return { seen: 0, correct: 0, streak: 0, lastSeen: null }; }

  /**
   * Initialises spaced-repetition fields.
   * @returns {{intervalDays:number,nextDue:number,lastReviewed:number}} SR info.
   */
  function initSR() { return { intervalDays: 0, nextDue: 0, lastReviewed: 0 }; }

  /**
   * Ensures a card object has required fields and normalises legacy values.
   * @param {object} c - Card object.
   * @returns {object} Hydrated card.
   */
  function hydrateCard(c) {
    if (!c) c = {};
    if (!c.id) c.id = uid();
    if (!c.type) c.type = 'flashcard';
    if (!c.stats) c.stats = initStats();
    if (!c.sr) c.sr = initSR();
    if (!c.topics) c.topics = [];
    if (typeof c.correct === 'undefined' && typeof c.answer === 'string') {
      c.correct = ({ A: 0, B: 1, C: 2, D: 3 }[c.answer.trim().toUpperCase()] ?? 0);
    }
    return c;
  }

  /**
   * Loads the deck from localStorage or creates a new one.
   * @returns {object} Deck.
   */
  function loadDeck() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return newDeck();
      var d = JSON.parse(raw);
      (d.cards || []).forEach(hydrateCard);
      buildTopicIndex(d);
      // expose for devtools/other scripts
      window.cards = d.cards;
      return d;
    } catch (e) { console.error(e); return newDeck(); }
  }

  /**
   * Builds a topic index mapping topic -> array of card IDs.
   * @param {object} d - Deck object to mutate.
   * @returns {void}
   */
  function buildTopicIndex(d) {
    var idx = {};
    (d.cards || []).forEach(function (c) { (c.topics || []).forEach(function (t) { (idx[t] || (idx[t] = [])).push(c.id); }); });
    d.topicIndex = idx;
  }

  /**
   * Replaces the current deck and persists it.
   * @param {object} newDeckObj - New deck object.
   * @returns {void}
   */
  function setDeck(newDeckObj) {
    deck = newDeckObj;
    buildTopicIndex(deck);
    window.cards = deck.cards;
    persist();
  }

  /**
   * Persists the current deck to localStorage and refreshes UI views if present.
   * @returns {void}
   */
  function persist() {
    deck.updatedAt = nowISO();
    localStorage.setItem(KEY, JSON.stringify(deck));
    window.cards = deck.cards;
    safe(updateOverview); safe(renderTopics); safe(renderReview);
  }

  // ---------- Import / Export ----------

  /**
   * Parses a topics cell into an array.
   * @param {string} s - Raw topics cell contents.
   * @returns {string[]} Topic list.
   */
  function parseTopicsCell(s) {
    if (!s) return [];
    return String(s).split(/[;,]/).map(function (t) { return t.trim(); }).filter(Boolean);
  }

  /**
   * Extracts cards from an XLSX workbook.
   * Requires a 'Flashcards' sheet and/or an 'MCQ' sheet.
   *
   * @param {object} wb - XLSX workbook instance.
   * @returns {object[]} Array of hydrated card objects.
   */
  function parseCardsFromXLSX(wb) {
    var out = [];

    function findSheet(name) {
      var keys = wb.SheetNames || [];
      for (var i = 0; i < keys.length; i++) {
        if (String(keys[i]).toLowerCase() === name.toLowerCase()) return wb.Sheets[keys[i]];
      }
      return null;
    }

    var wsF = findSheet('Flashcards');
    if (wsF) {
      var rowsF = XLSX.utils.sheet_to_json(wsF, { defval: '' });
      rowsF.forEach(function (r) {
        var front = r.front || r.Front || r.FRONT || '';
        var back = r.back || r.Back || r.BACK || '';
        var topics = r.topics || r.Topics || r.TOPICS || '';
        var explanation = r.explanation || r.Explanation || r.EXPLANATION || '';
        if (front || back) {
          out.push(hydrateCard({
            id: r.id || r.ID || uid(),
            type: 'flashcard',
            front: String(front),
            back: String(back),
            explanation: String(explanation || ''),
            topics: parseTopicsCell(topics)
          }));
        }
      });
    }

    var wsQ = findSheet('MCQ');
    if (wsQ) {
      var rowsQ = XLSX.utils.sheet_to_json(wsQ, { defval: '' });
      rowsQ.forEach(function (r) {
        var q = r.question || r.Question || r.QUESTION || '';
        var ca = r.choiceA || r.choicea || r.ChoiceA || r.CHOICEA || '';
        var cb = r.choiceB || r.choiceb || r.ChoiceB || r.CHOICEB || '';
        var cc = r.choiceC || r.choicec || r.ChoiceC || r.CHOICEC || '';
        var cd = r.choiceD || r.choiced || r.ChoiceD || r.CHOICED || '';
        var corr = r.correct || r.Correct || r.CORRECT || 'A';
        var topics = r.topics || r.Topics || r.TOPICS || '';
        var explanation = r.explanation || r.Explanation || r.EXPLANATION || '';
        if (q || ca || cb || cc || cd) {
          out.push(hydrateCard({
            id: r.id || r.ID || uid(),
            type: 'mcq',
            question: String(q),
            choices: [String(ca), String(cb), String(cc), String(cd)],
            answer: String(corr).trim().toUpperCase().charAt(0) || 'A',
            correct: ({ A: 0, B: 1, C: 2, D: 3 }[String(corr).trim().toUpperCase()] ?? 0),
            explanation: String(explanation || ''),
            topics: parseTopicsCell(topics)
          }));
        }
      });
    }
    return out;
  }

  /**
   * Inserts or updates cards within the deck, preserving stats and SR where applicable.
   * Alerts a summary when complete.
   * @param {object[]} newCards - Cards to upsert.
   * @returns {void}
   */
  function upsertCards(newCards) {
    var map = {}; deck.cards.forEach(function (c) { map[c.id] = c; });
    var added = 0, updated = 0;
    newCards.forEach(function (nc) {
      nc = hydrateCard(nc);
      if (map[nc.id]) {
        nc.stats = map[nc.id].stats || initStats();
        nc.sr = map[nc.id].sr || initSR();
        updated++;
      } else {
        if (!nc.stats) nc.stats = initStats();
        if (!nc.sr) nc.sr = initSR();
        added++;
      }
      map[nc.id] = nc;
    });
    deck.cards = Object.keys(map).map(function (k) { return map[k]; });
    buildTopicIndex(deck); persist();
    try { alert('Imported ' + added + ' new, updated ' + updated + '. Total ' + deck.cards.length + '.'); } catch (_e) {}
  }

  /**
   * Exports the current deck as JSON.
   * @returns {void}
   */
  function exportJSON() { downloadJSON(deck, 'cardcue_deck.json'); }

  /**
   * Exports the current deck as an XLSX workbook with 'Flashcards' and 'MCQ' sheets.
   * Requires SheetJS to be present on window.XLSX.
   * @returns {void}
   */
  function exportXLSX() {
    if (!window.XLSX) { alert('SheetJS not loaded'); return; }
    var fc = deck.cards.filter(function (c) { return c.type === 'flashcard'; }).map(function (c) {
      return { id: c.id, front: c.front || '', back: c.back || '', topics: (c.topics || []).join(','), explanation: c.explanation || '' };
    });
    var mcq = deck.cards.filter(function (c) { return c.type === 'mcq'; }).map(function (c) {
      return {
        id: c.id, question: c.question || '',
        choiceA: c.choices?.[0] || '', choiceB: c.choices?.[1] || '',
        choiceC: c.choices?.[2] || '', choiceD: c.choices?.[3] || '',
        correct: typeof c.correct === 'number' ? ['A', 'B', 'C', 'D'][c.correct] : (c.answer || 'A'),
        topics: (c.topics || []).join(','), explanation: c.explanation || ''
      };
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fc), 'Flashcards');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(mcq), 'MCQ');
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob('deck.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', out);
  }

  /**
   * Creates a template workbook suitable for import into CardCue.
   * @returns {object} XLSX workbook.
   */
  function makeTemplateWorkbook() {
    var wb = XLSX.utils.book_new();
    var flashRows = [
      ['id', 'front', 'back', 'topics', 'explanation'],
      ['F001', 'Sample front', 'Sample back', 'TopicA, TopicB', 'Optional explanation']
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(flashRows), 'Flashcards');
    var mcqRows = [
      ['id', 'question', 'choiceA', 'choiceB', 'choiceC', 'choiceD', 'correct', 'topics', 'explanation'],
      ['Q001', 'Sample MCQ?', 'Answer A', 'Answer B', 'Answer C', 'Answer D', 'A', 'Topic1, Topic2', 'Optional explanation']
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(mcqRows), 'MCQ');
    return wb;
  }

  // ---------- Stats + spaced repetition ----------

  /**
   * Records the result of a study interaction and updates spaced repetition.
   * @param {string} cardId - Card identifier.
   * @param {boolean} wasCorrect - Whether the response was correct.
   * @returns {void}
   */
  function markResult(cardId, wasCorrect) {
    var c = deck.cards.find(function (x) { return x.id === cardId; });
    if (!c) return;
    c.stats.seen += 1;
    if (wasCorrect) { c.stats.correct += 1; c.stats.streak += 1; } else { c.stats.streak = 0; }
    c.stats.lastSeen = nowISO();

    var stepIdx = Math.min(c.stats.streak, SR_STEPS.length - 1);
    var days = SR_STEPS[stepIdx];
    c.sr.intervalDays = days;
    c.sr.lastReviewed = nowMs();
    c.sr.nextDue = c.sr.lastReviewed + days * 24 * 3600 * 1000;

    persist();
  }

  // ---------- Public API ----------

  /** @type {any} */
  window.App = window.App || {};

  // Deck meta bootstrap and setter
  try { App.deckMeta = JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch (_) { App.deckMeta = null; }

  /**
   * Persist deck meta (file name + imported timestamp) and notify listeners.
   * @param {{name:string, importedAt:number}|null} meta
   */
  App.setDeckMeta = function (meta) {
    try {
      App.deckMeta = meta || null;
      if (meta) localStorage.setItem(META_KEY, JSON.stringify(meta));
      else localStorage.removeItem(META_KEY);
      window.dispatchEvent(new CustomEvent('app:deckLoaded', { detail: meta }));
    } catch (_) {}
  };

  /**
   * Retrieves the deck from storage without mutating in-memory state.
   * @returns {object} Deck object.
   */
  App.getDeck = function () { return JSON.parse(localStorage.getItem(KEY)) || newDeck(); };

  /**
   * Replaces the deck and persists.
   * @param {object} d - New deck.
   * @returns {void}
   */
  App.setDeck = setDeck;

  /**
   * Upserts cards into the deck and persists.
   * @param {object[]} cards - Cards to add or update.
   * @returns {void}
   */
  App.upsertCards = upsertCards;

  /**
   * Exports current deck as JSON.
   * @returns {void}
   */
  App.exportJSON = exportJSON;

  /**
   * Exports current deck as XLSX.
   * @returns {void}
   */
  App.exportXLSX = exportXLSX;

  /**
   * Produces an empty template workbook.
   * @returns {object} XLSX workbook.
   */
  App.makeTemplateWorkbook = makeTemplateWorkbook;

  /**
   * Accessor/mutator for app settings persisted to localStorage.
   */
  App.settings = {
    /**
     * Reads a setting value.
     * @param {string} key - Setting key.
     * @returns {any} Value.
     */
    get: function (key) { return __settings[key]; },
    /**
     * Sets a boolean setting and persists.
     * @param {string} key - Setting key.
     * @param {any} val - Value coerced to boolean.
     * @returns {void}
     */
    set: function (key, val) { __settings[key] = !!val; saveSettings(); },
    /**
     * Returns a shallow copy of all settings.
     * @returns {object} Settings snapshot.
     */
    all: function () { return Object.assign({}, __settings); }
  };

  /**
   * Persists and retrieves the view mode for the study UI.
   */
  App.viewMode = {
    /**
     * Reads the current mode.
     * @returns {string} Mode string.
     */
    get: function () { return localStorage.getItem(VIEWMODE_KEY) || 'single'; },
    /**
     * Sets the current mode.
     * @param {string} mode - Mode string.
     * @returns {void}
     */
    set: function (mode) { localStorage.setItem(VIEWMODE_KEY, mode); }
  };

  /**
   * Returns a sorted list of unique topics across the deck.
   * @returns {string[]} Topics.
   */
  App.topicsList = function () {
    var set = new Set();
    (deck.cards || []).forEach(function (c) { (c.topics || []).forEach(function (t) { set.add(t); }); });
    return Array.from(set).sort();
  };

  /**
   * Filters the deck according to options.
   * @param {object} [opts] - Filter options.
   * @param {string} [opts.search] - Case-insensitive text search across fields.
   * @param {string} [opts.topic] - Topic name to include.
   * @param {string} [opts.type] - 'flashcard' or 'mcq'.
   * @param {boolean} [opts.wrongOnly] - Include only cards answered incorrectly at least once.
   * @param {boolean} [opts.dueOnly] - Include only cards due by SR scheduling.
   * @param {boolean} [opts.shuffle] - Shuffle results.
   * @param {number} [opts.limit] - Maximum number of results.
   * @param {string[]} [opts.ids] - Restrict to specific IDs.
   * @returns {object[]} Filtered array of cards.
   */
  App.filterDeck = function (opts) {
    opts = opts || {};
    var search = (opts.search || '').toLowerCase();
    var topic = opts.topic || '';
    var type = opts.type || '';
    var wrongOnly = !!opts.wrongOnly;
    var dueOnly = !!opts.dueOnly;
    var ids = opts.ids ? new Set(opts.ids) : null;

    var arr = deck.cards.slice();

    if (ids) arr = arr.filter(function (c) { return ids.has(c.id); });
    if (type) arr = arr.filter(function (c) { return c.type === type; });
    if (topic) arr = arr.filter(function (c) { return (c.topics || []).indexOf(topic) >= 0; });
    if (search) {
      arr = arr.filter(function (c) {
        var hay = [
          c.id, c.type, c.front, c.back, c.question,
          (c.choices || []).join(' '), (c.topics || []).join(','), c.explanation
        ].join(' ').toLowerCase();
        return hay.indexOf(search) >= 0;
      });
    }
    if (wrongOnly) {
      arr = arr.filter(function (c) { return c.stats.correct < c.stats.seen; });
    }
    if (dueOnly) {
      var t = nowMs();
      arr = arr.filter(function (c) { return ((c.sr && c.sr.nextDue) || 0) <= t; });
    }
    if (opts.shuffle) App.shuffleInPlace(arr);
    if (opts.limit && arr.length > opts.limit) arr = arr.slice(0, opts.limit);

    try {
      if (window.App && App.viewMode && typeof App.viewMode.get === 'function') {
        if (App.viewMode.get() === 'grid') {
          if (arr.length > 9) arr = arr.slice(0, 9);
        }
      }
    } catch (_) {}

    return arr;
  };

  /**
   * Shuffles an array in place.
   * @param {any[]} a - Array to shuffle.
   * @returns {any[]} The same array reference.
   */
  App.shuffleInPlace = function (a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  /**
   * Records a result by card ID and updates SR.
   * @param {string} cardId - Card identifier.
   * @param {boolean} wasCorrect - Whether the response was correct.
   * @returns {void}
   */
  App.markResult = markResult;

  /**
   * Increments the persisted session counter.
   * @returns {void}
   */
  App.incrementSessionCount = function () {
    var n = parseInt(localStorage.getItem(KEY_SESSIONS) || '0', 10) + 1;
    localStorage.setItem(KEY_SESSIONS, String(n));
  };

  /**
   * Retrieves the persisted session counter.
   * @returns {number} Count.
   */
  App.getSessionCount = function () {
    return parseInt(localStorage.getItem(KEY_SESSIONS) || '0', 10);
  };

  /**
   * Registers key handlers for the study session.
   * Returns an unsubscribe function to remove listeners.
   * @param {Object.<string,Function>} handlers - Map of lower-case key -> handler.
   * @returns {Function} Unsubscribe function.
   */
  App.registerSessionShortcuts = function (handlers) {
    var map = new Map(Object.entries(handlers || {}));
    function onKey(e) { var k = e.key.toLowerCase(); if (map.has(k)) { e.preventDefault(); map.get(k)(); } }
    window.addEventListener('keydown', onKey);
    return function () { window.removeEventListener('keydown', onKey); };
  };

  /**
   * Registers navigation shortcuts for the preview UI.
   * Returns an unsubscribe function to remove listeners.
   * @param {{prev?:Function,next?:Function,toggle?:Function}} cb - Callback handlers.
   * @returns {Function} Unsubscribe function.
   */
  App.registerPreviewShortcuts = function (cb) {
    cb = cb || {};
    function onKey(e) {
      var k = e.key.toLowerCase();
      if (k === 'j') { e.preventDefault(); cb.prev && cb.prev(); }
      if (k === 'k') { e.preventDefault(); cb.next && cb.next(); }
      if (k === 'enter') { e.preventDefault(); cb.toggle && cb.toggle(); }
      if (k === 'arrowleft') { cb.prev && cb.prev(); }
      if (k === 'arrowright') { cb.next && cb.next(); }
    }
    window.addEventListener('keydown', onKey);
    return function () { window.removeEventListener('keydown', onKey); };
  };

  // ---------- Optional: Single-card viewer helper ----------

  /**
   * Creates a single-card viewer controller with “Show Answer” reveal behaviour.
   * @param {{getFilters:Function,elements:{
   *  host:HTMLElement,count:HTMLElement,btnPrev?:HTMLElement,btnNext?:HTMLElement,btnPeek?:HTMLElement
   * }}} cfg - Configuration.
   * @returns {{apply:Function,render:Function,prev:Function,next:Function,toggle:Function,index:number}} API.
   */
  App.createSingleViewer = function ({ getFilters, elements }) {
    const esc = s => s ? String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])) : '';
    let filtered = [];
    let idx = 0;

    let revealAll = !!App.settings.get('showExplanationByDefault');
    let revealed = revealAll;

    /**
     * Updates the label of the “Show Answer” button to reflect current reveal mode.
     * @returns {void}
     */
    function updatePeekLabel() {
      if (!elements.btnPeek) return;
      elements.btnPeek.textContent = revealAll ? 'Hide answers' : 'Show Answer (Enter)';
    }

    /**
     * Renders the HTML for a given card.
     * @param {object} c - Card.
     * @returns {string} HTML string.
     */
    function cardHTML(c) {
      const topics = esc((c.topics || []).join(', '));
      const isRevealed = revealAll || revealed;
      if (c.type === 'mcq') {
        const letters = ['A', 'B', 'C', 'D'];
        const opts = (c.choices || []).map((t, i) => `<div><strong>${letters[i]}.</strong> ${esc(t || '')}</div>`).join('');
        const correct = typeof c.correct === 'number' ? letters[c.correct] : (c.answer || 'A');
        return `<div class="meta"><span class="badge">${topics}</span><span class="badge">MCQ</span></div>
          <div class="q">${esc(c.question || '')}</div>
          <div class="options" style="margin-top:6px">${opts}</div>
          <div class="answer" ${isRevealed ? '' : 'hidden'} style="margin-top:10px;">
            <em>Correct:</em> ${correct}${c.explanation ? `<div class="placeholder" style="margin-top:6px">${esc(c.explanation)}</div>` : ''}
          </div>`;
      }
      return `<div class="meta"><span class="badge">${topics}</span><span class="badge">Flashcard</span></div>
        <div class="q"><strong>Front</strong><div>${esc(c.front || '')}</div></div>
        <div class="answer" ${isRevealed ? '' : 'hidden'} style="margin-top:10px;">
          <strong>Back</strong><div>${esc(c.back || '')}</div>
          ${c.explanation ? `<div class="placeholder" style="margin-top:6px">${esc(c.explanation)}</div>` : ''}
        </div>`;
    }

    /**
     * Applies current filters and re-renders.
     * @returns {void}
     */
    function apply() {
      filtered = App.filterDeck(getFilters());
      if (idx >= filtered.length) idx = Math.max(0, filtered.length - 1);
      revealed = revealAll;
      render();
    }

    /**
     * Renders the current card into the host element.
     * @returns {void}
     */
    function render() {
      const total = filtered.length;
      elements.count.textContent = total ? `${idx + 1} / ${total}` : '0 / 0';
      elements.host.classList.toggle('revealed', revealAll || revealed);
      elements.host.innerHTML = total ? cardHTML(filtered[idx]) : '<div class="placeholder">No cards match your filters.</div>';
      if (window.MathJax?.typesetPromise) MathJax.typesetPromise([elements.host]);
    }

    /**
     * Navigates to the previous card if available.
     * @returns {void}
     */
    function prev() { if (idx > 0) { idx--; revealed = revealAll; render(); } }

    /**
     * Navigates to the next card if available.
     * @returns {void}
     */
    function next() { if (idx < filtered.length - 1) { idx++; revealed = revealAll; render(); } }

    /**
     * Toggles the global reveal state and persists the setting.
     * @returns {void}
     */
    function toggle() {
      revealAll = !revealAll;
      App.settings.set('showExplanationByDefault', revealAll);
      revealed = revealAll;
      updatePeekLabel();
      render();
    }

    elements.btnPrev?.addEventListener('click', prev);
    elements.btnNext?.addEventListener('click', next);
    elements.btnPeek?.addEventListener('click', toggle);
    App.registerPreviewShortcuts({ prev, next, toggle });

    const api = {
      apply, render, prev, next, toggle,
      get index() { return idx; },
      set index(i) { idx = Math.max(0, Math.min(i, (filtered.length || 1) - 1)); revealed = revealAll; render(); }
    };
    api.apply();
    updatePeekLabel();
    return api;
  };

  // ---------- Shell right-panel binder (import/export on every page) ----------

  /** @type {boolean} */
  var __importBindingsDone = false;

  /**
   * Binds import/export/template/reset/clear actions in the shell panel.
   * Safely no-ops if the panel is not present.
   * @returns {void}
   */
  App.initImportExportBindings = function () {
    if (__importBindingsDone) return;
    var importBtn = document.getElementById('btn-import');
    var fileInput = document.getElementById('file-input');
    if (!importBtn || !fileInput) return;
    __importBindingsDone = true;

    importBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function (ev) {
      var files = ev.target.files; if (!files || !files.length) return;
      var pending = files.length; var collected = [];
      var replace = document.getElementById('chk-replace-import')?.checked;

      function doneOne() {
        pending--;
        if (pending === 0 && collected.length) {
          if (replace) {
            var fresh = newDeck(); fresh.createdAt = deck.createdAt;
            setDeck(fresh);
          }
          upsertCards(collected);

          // --- NEW: record file name + timestamp for the Overview header ---
          var friendly = (files && files.length)
            ? (files.length === 1 ? files[0].name : (files[0].name + ' +' + (files.length - 1) + ' more'))
            : 'Imported deck';
          App.setDeckMeta({ name: friendly, importedAt: Date.now() });
          // ----------------------------------------------------------------

          fileInput.value = '';
        }
      }

      for (var i = 0; i < files.length; i++) {
        (function (f) {
          if (/\.xlsx$/i.test(f.name)) {
            var r1 = new FileReader();
            r1.onload = function () {
              try {
                var data = new Uint8Array(r1.result);
                var wb = XLSX.read(data, { type: 'array' });
                var arr = parseCardsFromXLSX(wb);
                if (arr && arr.length) collected = collected.concat(arr);
              } catch (e) { console.error('XLSX import error in ' + f.name, e); }
              doneOne();
            };
            r1.readAsArrayBuffer(f);
          } else if (/\.json$/i.test(f.name)) {
            var r2 = new FileReader();
            r2.onload = function () {
              try {
                var txt = r2.result || '';
                var d = JSON.parse(txt);
                if (d && d.cards) collected = collected.concat(d.cards.map(hydrateCard));
                else if (Array.isArray(d)) collected = collected.concat(d.map(hydrateCard));
              } catch (e) { console.error('JSON import error in ' + f.name, e); }
              doneOne();
            };
            r2.readAsText(f);
          } else {
            console.warn('Unsupported file type (use .xlsx or .json):', f.name);
            doneOne();
          }
        })(files[i]);
      }
    });

    document.getElementById('btn-export')?.addEventListener('click', exportJSON);
    document.getElementById('btn-template-xlsx')?.addEventListener('click', function () {
      if (!window.XLSX) { alert('SheetJS not loaded'); return; }
      var wb = makeTemplateWorkbook();
      var buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      downloadBlob('deck_template.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buf);
    });
    document.getElementById('btn-export-xlsx')?.addEventListener('click', exportXLSX);

    document.getElementById('btn-reset')?.addEventListener('click', function () {
      if (confirm('Reset all stats?')) {
        deck.cards.forEach(function (c) { c.stats = initStats(); c.sr = initSR(); });
        persist();
      }
    });
    document.getElementById('btn-clear')?.addEventListener('click', function () {
      if (!confirm('Delete ALL cards and progress? This cannot be undone.')) return;
      deck = newDeck();
      localStorage.setItem(KEY, JSON.stringify(deck));
      App.setDeckMeta(null); // NEW: clear filename/date meta
      safe(updateOverview); safe(renderTopics); safe(renderReview);
      alert('Deck cleared. Add cards via Import (Excel/JSON).');
    });
  };

  // ---------- Study page binder (if those elements exist) ----------

  /** @type {{pool:object[],idx:number,correct:number,wrongs:object[]}} */
  var session = { pool: [], idx: 0, correct: 0, wrongs: [] };

  /**
   * Reads selected topics from the UI (chips or legacy list).
   * @returns {string[]|null} Array of topics, or null for "all".
   */
  function readSelectedTopics() {
    var host = $('#topic-list'); if (!host) return null;
    if (host.tagName === 'UL') {
      var active = host.querySelector('li.active');
      var val = active ? active.getAttribute('data-topic') : '__ALL__';
      return (val && val !== '__ALL__') ? [val] : null;
    }
    var boxes = host.querySelectorAll('input[name="topics"]:checked');
    var arr = Array.prototype.map.call(boxes, function (n) { return n.value; });
    return arr.length ? arr : null;
  }

  /**
   * Builds the working set of cards for a session based on UI controls.
   * @returns {object[]} The session pool.
   */
  function buildWorkingSet() {
    // new ids (fall back to legacy ones if absent)
    var allowMCQ   = ($('#inc-mcq')?.checked ?? $('#chk-mcq')?.checked) ?? true;
    var allowFlash = ($('#inc-flashcards')?.checked ?? $('#chk-flash')?.checked) ?? true;
    var wrongOnly  = ($('#wrong-only')?.checked ?? $('#chk-wrong')?.checked) ?? false;
    var shuffle    = ($('#shuffle')?.checked ?? $('#chk-shuffle')?.checked) ?? false;
    var sizeVal    = $('#session-size')?.value || $('#inp-size')?.value || '20';
    var size       = Math.max(1, parseInt(sizeVal, 10) || 20);

    var selectedTopics = readSelectedTopics(); // null => all

    var base = deck.cards.filter(function (c) {
      return (c.type === 'mcq' && allowMCQ) || (c.type === 'flashcard' && allowFlash);
    });

    if (selectedTopics) {
      var set = new Set(selectedTopics);
      base = base.filter(function (c) {
        var topics = c.topics || [];
        for (var i = 0; i < topics.length; i++) if (set.has(topics[i])) return true;
        return false;
      });
    }

    var pool = wrongOnly ? base.filter(function (c) { return c.stats.correct < c.stats.seen; }) : base;
    if (shuffle) pool = fisherYates(pool);
    if (pool.length > size) pool = pool.slice(0, size);
    return pool;
  }

  /**
   * Renders the current card view for the session.
   * @returns {void}
   */
  function renderCard() {
    var i = session.idx; var total = session.pool.length; var c = session.pool[i];
    $('#sess-idx') && ($('#sess-idx').textContent = i + 1);
    $('#sess-correct') && ($('#sess-correct').textContent = session.correct);
    $('#meter-progress') && ($('#meter-progress').style.width = Math.round(100 * i / Math.max(1, total)) + '%');
    var host = $('#card'); if (!host) return;

    if (!c) {
      host.innerHTML =
        '<p><strong>Session complete.</strong> Score: ' + session.correct + '/' + total + '</p>' +
        (session.wrongs.length
          ? '<p>You missed ' + session.wrongs.length + '.</p><div class="row"><button id="btn-redo-wrongs" class="btn primary">Redo wrongs</button> <button id="btn-new-session" class="btn">New session</button></div>'
          : '<div class="row"><button id="btn-new-session" class="btn">New session</button></div>');
      $('#btn-redo-wrongs')?.addEventListener('click', function () {
        session = { pool: session.wrongs.slice(), idx: 0, correct: 0, wrongs: [] };
        $('#sess-total') && ($('#sess-total').textContent = session.pool.length);
        renderCard();
      });
      $('#btn-new-session')?.addEventListener('click', startSession);
      typesetMath(host);
      return;
    }

    if (c.type === 'mcq') {
      var html = '';
      html += '<div class="badge">' + escapeHTML((c.topics || []).join(', ') || '') + '</div>';
      html += '<h3>' + escapeHTML(c.question || '') + '</h3>';
      html += '<div class="choices">';
      var letters = ['A', 'B', 'C', 'D'];
      for (var ii = 0; ii < 4; ii++) {
        var txt = c.choices[ii] || '';
        html += '<button class="choice" data-letter="' + letters[ii] + '"><strong>' + letters[ii] + ')</strong> ' + escapeHTML(txt) + '</button>';
      }
      html += '</div>';
      html += '<p id="explain" class="placeholder" style="display:none"></p>';
      html += '<div class="field"><button id="btn-repeat" class="btn">Repeat later</button> <button id="btn-next-inline" class="btn">Next</button></div>';
      host.innerHTML = html;
      $$('#card .choice').forEach(function (btn) {
        btn.addEventListener('click', function () { gradeMCQ(c, btn.getAttribute('data-letter')); });
      });
      $('#btn-repeat')?.addEventListener('click', function () { enqueueForRepeat(c); nextCard(); });
      $('#btn-next-inline')?.addEventListener('click', function () { nextCard(); });
      typesetMath(host);
    } else {
      var html2 = '';
      html2 += '<div class="badge">' + escapeHTML((c.topics || []).join(', ') || '') + '</div>';
      html2 += '<div class="flash">';
      html2 += '<div class="face"><strong>Front</strong><div>' + escapeHTML(c.front || '') + '</div></div>';
      html2 += '<div class="face" id="face-back" style="display:none"><strong>Back</strong><div>' + escapeHTML(c.back || '') + '</div></div>';
      html2 += '</div>';
      html2 += '<div class="field">' +
        '<button id="btn-flip" class="btn">Flip</button> ' +
        '<button id="btn-got" class="btn">Got it</button> ' +
        '<button id="btn-miss" class="btn">Missed</button> ' +
        '<button id="btn-repeat-f" class="btn">Repeat later</button>' +
        '</div>';
      if (c.explanation) { html2 += '<p class="placeholder">' + escapeHTML(c.explanation) + '</p>'; }
      host.innerHTML = html2;
      if (App.settings.get('showExplanationByDefault')) {
        var back = $('#face-back'); if (back) back.style.display = 'block';
      }
      $('#btn-flip')?.addEventListener('click', function () {
        var back = $('#face-back'); back.style.display = (back.style.display === 'none' ? 'block' : 'none'); typesetMath(host);
      });
      $('#btn-got')?.addEventListener('click', function () {
        record(c, true); session.correct += 1;
        if (App.settings.get('autoAdvanceOnCorrect') && session.idx < session.pool.length - 1) {
          setTimeout(nextCard, 300);
        } else {
          nextCard();
        }
      });
      $('#btn-miss')?.addEventListener('click', function () { record(c, false); session.wrongs.push(c); enqueueForRepeat(c); nextCard(); });
      $('#btn-repeat-f')?.addEventListener('click', function () { enqueueForRepeat(c); nextCard(); });
      typesetMath(host);
    }
  }

  /**
   * Grades an MCQ answer, updates UI and spaced repetition.
   * @param {object} c - Card.
   * @param {string} letter - Selected letter A-D.
   * @returns {void}
   */
  function gradeMCQ(c, letter) {
    var letters = ['A', 'B', 'C', 'D'];
    var chosenIdx = letters.indexOf(letter);
    var isCorrect = (typeof c.correct === 'number') ? (chosenIdx === c.correct) : (letter === (c.answer || 'A'));
    record(c, isCorrect);
    if (isCorrect) session.correct += 1; else session.wrongs.push(c);
    $$('#card .choice').forEach(function (btn) {
      btn.setAttribute('disabled', 'disabled');
      var L = btn.getAttribute('data-letter');
      var okLetter = typeof c.correct === 'number' ? letters[c.correct] : (c.answer || 'A');
      if (L === okLetter) { btn.className += ' correct'; }
      if (L === letter && !isCorrect) { btn.className += ' incorrect'; }
    });
    var exp = $('#explain'); if (c.explanation) { exp.textContent = c.explanation; exp.style.display = 'block'; }
    if (isCorrect && App.settings.get('autoAdvanceOnCorrect')) {
      if (session.idx < session.pool.length - 1) setTimeout(nextCard, 450);
    }
  }

  /**
   * Records an attempt result on a specific card and updates SR scheduling.
   * @param {object} c - Card.
   * @param {boolean} isCorrect - Whether the response was correct.
   * @returns {void}
   */
  function record(c, isCorrect) {
    c.stats.seen += 1;
    if (isCorrect) { c.stats.correct += 1; c.stats.streak += 1; } else { c.stats.streak = 0; }
    c.stats.lastSeen = nowISO();
    var stepIdx = Math.min(c.stats.streak, SR_STEPS.length - 1);
       var days = SR_STEPS[stepIdx];
    c.sr.intervalDays = days;
    c.sr.lastReviewed = nowMs();
    c.sr.nextDue = c.sr.lastReviewed + days * 24 * 3600 * 1000;
    persist();
  }

  /**
   * Queues a card to be repeated later in the session.
   * @param {object} c - Card.
   * @returns {void}
   */
  function enqueueForRepeat(c) {
    session.pool.push(c);
    $('#sess-total') && ($('#sess-total').textContent = session.pool.length);
  }

  /**
   * Advances to the next card or completes the session.
   * @returns {void}
   */
  function nextCard() {
    if (session.idx < session.pool.length - 1) { session.idx += 1; renderCard(); }
    else { session.idx = session.pool.length; renderCard(); }
  }

  /**
   * Initialiser for the study page. Wires buttons, loads stats and applies options.
   * Supports Learn/Test mode toggling with different UI panels.
   * @returns {void}
   */
  App.initStudyPage = function () {
    updateOverview(); renderTopics(); renderReview();

    // Learn buttons
    $('#btn-start')?.addEventListener('click', startSession);
    $('#btn-prev')?.addEventListener('click', function () { if (session.idx > 0) { session.idx -= 1; renderCard(); } });
    $('#btn-next')?.addEventListener('click', function () { nextCard(); });
    $('#btn-end')?.addEventListener('click', function () { session.idx = session.pool.length; renderCard(); });

    // Settings checkboxes
    var chkShowExp = $('#opt-show-exp');
    var chkAutoAdv = $('#opt-auto-adv');
    if (chkShowExp) {
      chkShowExp.checked = !!App.settings.get('showExplanationByDefault');
      chkShowExp.addEventListener('change', () => App.settings.set('showExplanationByDefault', chkShowExp.checked));
    }
    if (chkAutoAdv) {
      chkAutoAdv.checked = !!App.settings.get('autoAdvanceOnCorrect');
      chkAutoAdv.addEventListener('change', () => App.settings.set('autoAdvanceOnCorrect', chkAutoAdv.checked));
    }

    // Tabs
    const tabLearn = $('#tab-learn');
    const tabTest  = $('#tab-test');
    const learnBar = $('#learn-bar') || $('#session-ui');
    const testBar  = $('#test-bar');

    // ---------- Mode toggle ----------
    function setMode(m) {
      document.body.dataset.mode = m; // "learn" | "test"
      tabLearn?.classList.toggle('active', m === 'learn');
      tabTest?.classList.toggle('active', m === 'test');
      if (learnBar) learnBar.hidden = (m !== 'learn');
      if (testBar)  testBar.hidden  = (m !== 'test');

      if (m === 'test') {
        // ensure any test presets are reflected in UI redraws that depend on mode
      }
      safe(renderCard);
    }

    // Default mode early to ensure one bar is visible even if later code hiccups
    if (!document.body.dataset.mode) setMode('learn');

    tabLearn?.addEventListener('click', () => setMode('learn'));
    tabTest?.addEventListener('click', () => setMode('test'));
  };

  /**
   * Starts a new study session with the current UI filters (legacy/start button flow).
   * @returns {void}
   */
  function startSession() {
    var pool = buildWorkingSet();
    if (!pool.length) { alert('No cards match your filters.'); return; }
    startSessionFromPool(pool);
  }

  /**
   * Starts a session from a provided pool (used by the new form flow).
   * @param {object[]} pool - Prefiltered cards.
   * @returns {void}
   */
  function startSessionFromPool(pool) {
    session = { pool: pool, idx: 0, correct: 0, wrongs: [] };
    App.incrementSessionCount();
    $('#session-empty')?.setAttribute('hidden', 'hidden');
    $('#session-ui')?.removeAttribute('hidden');
    $('#sess-total') && ($('#sess-total').textContent = pool.length);
    renderCard();
  }

  // ---------- Public bridge for new Test-bar form flow ----------

  /**
   * Builds a pool from test filters and starts a session.
   * @param {{plan?:'cram'|'daily', type?:''|'flashcard'|'mcq', wrongOnly?:boolean, dueOnly?:boolean, shuffle?:boolean, count?:number}} opts
   * @returns {void}
   */
  App.startSessionFromFilters = function (opts) {
    opts = opts || {};
    var type = opts.type || '';
    var wrongOnly = !!opts.wrongOnly;
    var dueOnly = !!opts.dueOnly;
    var shuffle = !!opts.shuffle;
    var count = Math.max(1, parseInt(opts.count, 10) || 20);

    // Plan presets (in case caller didn't apply them in the UI)
    if (opts.plan === 'cram') {
      wrongOnly = true; dueOnly = false; shuffle = true;
    } else if (opts.plan === 'daily') {
      wrongOnly = false; dueOnly = true; shuffle = false;
    }

    var filtered = App.filterDeck({ type: type, wrongOnly: wrongOnly, dueOnly: dueOnly, shuffle: shuffle });
    if (filtered.length > count) filtered = filtered.slice(0, count);
    if (!filtered.length) { alert('No cards match your test filters.'); return; }
    startSessionFromPool(filtered);
  };

  /**
   * Renders the topic UI. Supports legacy <ul> list and new “chips” container.
   * @returns {void}
   */
  function renderTopics() {
    var host = $('#topic-list'); if (!host) return;

    var topics = App.topicsList();
    // Legacy UL mode
    if (host.tagName === 'UL') {
      host.innerHTML = '';
      var liAll = document.createElement('li');
      liAll.textContent = 'All topics (' + deck.cards.length + ')';
      liAll.setAttribute('data-topic', '__ALL__'); liAll.className = 'active';
      liAll.addEventListener('click', function () { $$('#topic-list li').forEach(function (n) { n.className = ''; }); liAll.className = 'active'; });
      host.appendChild(liAll);
      topics.forEach(function (t) {
        var count = (deck.topicIndex[t] || []).length;
        var li = document.createElement('li'); li.setAttribute('data-topic', t); li.textContent = t + ' (' + count + ')';
        li.addEventListener('click', function () { $$('#topic-list li').forEach(function (n) { n.className = ''; }); li.className = 'active'; });
        host.appendChild(li);
      });
      return;
    }

    // New chips mode (div/container)
    host.innerHTML = '';
    topics.forEach(function (t, i) {
      var id = 'topic-' + i;
      var input = document.createElement('input');
      input.type = 'checkbox'; input.className = 'chip';
      input.id = id; input.name = 'topics'; input.value = t; input.checked = true;

      var label = document.createElement('label');
      label.htmlFor = id; label.textContent = t;

      host.appendChild(input);
      host.appendChild(label);
    });
  }

  /**
   * Updates high-level statistics and meters on the study page.
   * @returns {void}
   */
  function updateOverview() {
    var totalEl = $('#stat-cards'); if (!totalEl) return;
    var total = deck.cards.length; totalEl.textContent = total;
    var seen = 0, correct = 0, wrong = 0;
    deck.cards.forEach(function (c) {
      seen += c.stats.seen; correct += c.stats.correct; if (c.stats.seen > c.stats.correct) wrong++;
    });
    var acc = seen ? Math.round(100 * correct / seen) : 0;
    $('#stat-acc') && ($('#stat-acc').textContent = acc + '%');
    $('#stat-wrong') && ($('#stat-wrong').textContent = wrong);
    $('#meter-acc') && ($('#meter-acc').style.width = acc + '%');
  }

  /**
   * Renders the review table of all cards with per-card statistics.
   * @returns {void}
   */
  function renderReview() {
    var tbody = $('#review-body'); if (!tbody) return; tbody.innerHTML = '';
    deck.cards.forEach(function (c) {
      var acc = c.stats.seen ? Math.round(100 * c.stats.correct / c.stats.seen) : 0;
      var prompt = c.type === 'mcq' ? c.question : c.front;
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + escapeHTML(c.id) + '</td>' +
        '<td>' + c.type + '</td>' +
        '<td>' + escapeHTML((prompt || '').slice(0, 160)) + '</td>' +
        '<td>' + escapeHTML((c.topics || []).join(', ')) + '</td>' +
        '<td>' + c.stats.seen + '</td>' +
        '<td>' + c.stats.correct + '</td>' +
        '<td>' + acc + '%</td>' +
        '<td>' + c.stats.streak + '</td>';
      tbody.appendChild(tr);
    });
    typesetMath(tbody);
  }

  // ---------- Public bridge for new form flow (legacy compatibility) ----------

  /**
   * Starts a session when called externally with a preselected set.
   * Exposed for the new study form (topic chips).
   * @param {object[]} selected - Cards selected by the UI.
   * @returns {void}
   */
  window.startSession = function (selected) {
    if (!selected || !selected.length) { alert('No cards match your filters.'); return; }
    startSessionFromPool(selected);
  };

  // ---------- Initial: pages call init functions ----------
})();
