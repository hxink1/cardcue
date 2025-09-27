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

  /** Query helpers */
  var $  = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /** Time helpers */
  var nowISO = function () { return new Date().toISOString(); };
  var nowMs  = function () { return Date.now(); };

  /** Id + utils */
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function typesetMath(container) {
    if (window.MathJax && typeof window.MathJax.typesetPromise === 'function') {
      try { window.MathJax.typesetClear && window.MathJax.typesetClear(); } catch (_e) {}
      return window.MathJax.typesetPromise(container ? [container] : undefined).catch(function (e) {
        console.error('MathJax typeset error:', e);
      });
    }
    return Promise.resolve();
  }
  function escapeHTML(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch];
    });
  }
  function downloadJSON(obj, filename) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function downloadBlob(name, mime, buffer) {
    var blob = new Blob([buffer], { type: mime });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }
  function fisherYates(arr) {
    var a = arr.slice(), i, j, t;
    for (i = a.length - 1; i > 0; i--) { j = Math.floor(Math.random() * (i + 1)); t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function safe(fn) { try { typeof fn === 'function' && fn(); } catch (_e) {} }

  // ---------- Namespaced storage (DEV/PROD isolation) ----------
  var APP_NS = (function () {
    try {
      var first = location.pathname.split('/').filter(Boolean)[0] || 'cardcue';
      return 'cardcue:' + first; // e.g. cardcue:cardcue-dev
    } catch (_) { return 'cardcue:default'; }
  })();

  // Keys (single source of truth)
  const KEY           = APP_NS + ':deck:v1';
  const KEY_SESSIONS  = APP_NS + ':sessions';
  const SETTINGS_KEY  = APP_NS + ':settings';
  const VIEWMODE_KEY  = APP_NS + ':viewMode';
  const SR_STEPS      = [1, 3, 7, 14]; // days

  // ---------- Settings (persisted) ----------
  var defaultSettings = { showExplanationByDefault: false, autoAdvanceOnCorrect: false };
  function loadSettings() {
    try { return Object.assign({}, defaultSettings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
    catch (_e) { return Object.assign({}, defaultSettings); }
  }
  var __settings = loadSettings();
  function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(__settings)); }

  // ---------- Storage + model ----------
  /** @type {{version:number,createdAt:string,updatedAt:string,cards:Array,topicIndex:Object}} */
  var deck = loadDeck();

  function newDeck() {
    return { version: 1, createdAt: nowISO(), updatedAt: nowISO(), cards: [], topicIndex: {} };
  }
  function initStats() { return { seen: 0, correct: 0, streak: 0, lastSeen: null }; }
  function initSR()    { return { intervalDays: 0, nextDue: 0, lastReviewed: 0 }; }

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

  function loadDeck() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return newDeck();
      var d = JSON.parse(raw);
      (d.cards || []).forEach(hydrateCard);
      buildTopicIndex(d);
      window.cards = d.cards; // for devtools
      return d;
    } catch (e) { console.error(e); return newDeck(); }
  }
  function buildTopicIndex(d) {
    var idx = {};
    (d.cards || []).forEach(function (c) { (c.topics || []).forEach(function (t) { (idx[t] || (idx[t] = [])).push(c.id); }); });
    d.topicIndex = idx;
  }
  function setDeck(newDeckObj) {
    deck = newDeckObj;
    buildTopicIndex(deck);
    window.cards = deck.cards;
    persist();
  }
  function persist() {
    deck.updatedAt = nowISO();
    localStorage.setItem(KEY, JSON.stringify(deck));
    window.cards = deck.cards;
    safe(updateOverview); safe(renderTopics); safe(renderReview);
  }

  // ---------- Import / Export ----------
  function parseTopicsCell(s) {
    if (!s) return [];
    return String(s).split(/[;,]/).map(function (t) { return t.trim(); }).filter(Boolean);
  }

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

  function exportJSON() { downloadJSON(deck, 'cardcue_deck.json'); }
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
  window.App = window.App || {};

  App.getDeck   = function () { return JSON.parse(localStorage.getItem(KEY)) || newDeck(); };
  App.setDeck   = setDeck;
  App.upsertCards = upsertCards;
  App.exportJSON  = exportJSON;
  App.exportXLSX  = exportXLSX;
  App.makeTemplateWorkbook = makeTemplateWorkbook;

  App.settings = {
    get: function (key) { return __settings[key]; },
    set: function (key, val) { __settings[key] = !!val; saveSettings(); },
    all: function () { return Object.assign({}, __settings); }
  };

  App.viewMode = {
    get: function () { return localStorage.getItem(VIEWMODE_KEY) || 'single'; },
    set: function (mode) { localStorage.setItem(VIEWMODE_KEY, mode); }
  };

  App.topicsList = function () {
    var set = new Set();
    (deck.cards || []).forEach(function (c) { (c.topics || []).forEach(function (t) { set.add(t); }); });
    return Array.from(set).sort();
  };

  App.filterDeck = function (opts) {
    opts = opts || {};
    var search = (opts.search || '').toLowerCase();
    var topic = opts.topic || '';
    var type = opts.type || '';
    var wrongOnly = !!opts.wrongOnly;
    var dueOnly = !!opts.dueOnly;
    var ids = opts.ids ? new Set(opts.ids) : null;

    var arr = deck.cards.slice();

    if (ids)   arr = arr.filter(function (c) { return ids.has(c.id); });
    if (type)  arr = arr.filter(function (c) { return c.type === type; });
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
    return arr;
  };

  App.shuffleInPlace = function (a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  App.markResult = markResult;

  App.incrementSessionCount = function () {
    var n = parseInt(localStorage.getItem(KEY_SESSIONS) || '0', 10) + 1;
    localStorage.setItem(KEY_SESSIONS, String(n));
  };
  App.getSessionCount = function () {
    return parseInt(localStorage.getItem(KEY_SESSIONS) || '0', 10);
    };

  // ---------- Study page binder ----------
  var session = { pool: [], idx: 0, correct: 0, wrongs: [] };

  function readSelectedTopics() {
    var host = $('#topic-list'); if (!host) return null; // dropdown path uses filterDeck(topic)
    if (host.tagName === 'UL') {
      var active = host.querySelector('li.active');
      var val = active ? active.getAttribute('data-topic') : '__ALL__';
      return (val && val !== '__ALL__') ? [val] : null;
    }
    var boxes = host.querySelectorAll('input[name="topics"]:checked');
    var arr = Array.prototype.map.call(boxes, function (n) { return n.value; });
    return arr.length ? arr : null;
  }

  function buildWorkingSet() {
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

  function enqueueForRepeat(c) {
    session.pool.push(c);
    $('#sess-total') && ($('#sess-total').textContent = session.pool.length);
  }

  function nextCard() {
    if (session.idx < session.pool.length - 1) { session.idx += 1; renderCard(); }
    else { session.idx = session.pool.length; renderCard(); }
  }

  App.initStudyPage = function () {
    updateOverview(); renderTopics(); renderReview();
    $('#btn-start')?.addEventListener('click', startSession);
    $('#btn-prev')?.addEventListener('click', function () { if (session.idx > 0) { session.idx -= 1; renderCard(); } });
    $('#btn-next')?.addEventListener('click', function () { nextCard(); });
    $('#btn-end')?.addEventListener('click', function () { session.idx = session.pool.length; renderCard(); });

    var chkShowExp = $('#opt-show-exp');
    var chkAutoAdv = $('#opt-auto-adv');
    if (chkShowExp) {
      chkShowExp.checked = !!App.settings.get('showExplanationByDefault');
      chkShowExp.addEventListener('change', function () { App.settings.set('showExplanationByDefault', chkShowExp.checked); });
    }
    if (chkAutoAdv) {
      chkAutoAdv.checked = !!App.settings.get('autoAdvanceOnCorrect');
      chkAutoAdv.addEventListener('change', function () { App.settings.set('autoAdvanceOnCorrect', chkAutoAdv.checked); });
    }
  };

  function startSession() {
    var pool = buildWorkingSet();
    if (!pool.length) { alert('No cards match your filters.'); return; }
    startSessionFromPool(pool);
  }

  function startSessionFromPool(pool) {
    session = { pool: pool, idx: 0, correct: 0, wrongs: [] };
    App.incrementSessionCount();
    $('#session-empty')?.setAttribute('hidden', 'hidden');
    $('#session-ui')?.removeAttribute('hidden');
    $('#sess-total') && ($('#sess-total').textContent = pool.length);
    renderCard();
  }

  function renderTopics() {
    var host = $('#topic-list'); if (!host) return; // fine if removed/hidden

    var topics = App.topicsList();
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

    // Chips mode (kept for compatibility)
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

  // Public bridge for new form flow
  window.startSession = function (selected) {
    if (!selected || !selected.length) { alert('No cards match your filters.'); return; }
    startSessionFromPool(selected);
  };

})();
