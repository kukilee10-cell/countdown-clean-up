/* ════════════════════════════════════════════════════════════
   FIFO Countdown — application script
   Vanilla JS, no build step. Loaded from index.html with `defer`.
   localStorage keys match the original build (fifo_*_v1) so all
   existing user data continues to work unchanged.
   ════════════════════════════════════════════════════════════ */
'use strict';

(() => {
  // ── localStorage keys (DO NOT RENAME — user data depends on these)
  const KEYS = {
    roster:     'fifo_roster_v1',
    alarm:      'fifo_alarm_v1',
    spotify:    'fifo_spotify_v1',
    dontForget: 'fifo_dont_forget_v1',
    notes:      'fifo_notes_v1',
    reminders:  'fifo_reminders_v1',
    flight:     'fifo_flight_v1',
  };

  // ── tiny DOM helpers
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* ──────────────────────────────────────────────────────────
     STORAGE
     ────────────────────────────────────────────────────────── */
  const readJSON = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  };
  const writeJSON = (key, value) => localStorage.setItem(key, JSON.stringify(value));

  const loadRoster    = () => readJSON(KEYS.roster, null);
  const saveRoster    = (d) => writeJSON(KEYS.roster, d);
  const loadAlarm     = () => readJSON(KEYS.alarm, { time: '06:00', on: false, snooze: 10 });
  const saveAlarm     = (d) => writeJSON(KEYS.alarm, d);
  const loadSpotify   = () => readJSON(KEYS.spotify, { url: '' });
  const saveSpotify   = (d) => writeJSON(KEYS.spotify, d);
  const REM_COLORS = {
    red:    { bg: '#ef4444', fg: '#ffffff', label: 'Red' },
    orange: { bg: '#f97316', fg: '#ffffff', label: 'Orange' },
    yellow: { bg: '#eab308', fg: '#0d0f12', label: 'Yellow' },
    green:  { bg: '#10b981', fg: '#ffffff', label: 'Green' },
    blue:   { bg: '#3b82f6', fg: '#ffffff', label: 'Blue' },
    purple: { bg: '#8b5cf6', fg: '#ffffff', label: 'Purple' },
    pink:   { bg: '#ec4899', fg: '#ffffff', label: 'Pink' },
  };
  const REM_COLOR_KEYS = Object.keys(REM_COLORS);
  const normalizeReminder = (r) =>
    typeof r === 'string'
      ? { text: r, color: null }
      : { text: (r && r.text) || '', color: (r && r.color && REM_COLORS[r.color]) ? r.color : null };
  const loadReminders = () => {
    const raw = readJSON(KEYS.reminders, {});
    const out = {};
    for (const k in raw) {
      const list = (raw[k] || []).map(normalizeReminder);
      if (list.length) out[k] = list;
    }
    return out;
  };
  const saveReminders = (d) => writeJSON(KEYS.reminders, d);
  // Selected color for the "add new reminder" picker (per open of subpanel)
  let remPickerColor = null;

  /* ──────────────────────────────────────────────────────────
     DATE HELPERS
     ────────────────────────────────────────────────────────── */
  const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
  const parseDate  = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const formatDate = (d) => d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const diffDays   = (a, b) => Math.round((b - a) / 86400000);
  const addDays    = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const pad2       = (n) => String(n).padStart(2, '0');
  const isoDate    = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fmt12 = (t) => {
    if (!t) return '--:--';
    const [hStr, m] = t.split(':');
    let h = parseInt(hStr, 10);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ap}`;
  };

  /* ──────────────────────────────────────────────────────────
     AUDIO  —  loud beep loop + silent keepalive
     ────────────────────────────────────────────────────────── */
  const audio = {
    ctx: null,
    beepLoop: null,
    keepAlive: null,
    silentEl: null,
    testing: false,
  };

  // 1-second silent WAV, looped, keeps iOS audio session warm.
  const SILENT_WAV = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';

  const getCtx = () => {
    if (!audio.ctx) {
      try { audio.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { /* unsupported */ }
    }
    return audio.ctx;
  };

  const resumeCtx = () => {
    const ctx = getCtx();
    if (!ctx) return Promise.resolve();
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      return ctx.resume().catch(() => {});
    }
    return Promise.resolve();
  };

  const playSilentLoop = () => {
    if (!audio.silentEl) {
      audio.silentEl = new Audio(SILENT_WAV);
      audio.silentEl.loop = true;
      audio.silentEl.preload = 'auto';
      // Restart immediately if the OS pauses or ends the silent track
      audio.silentEl.addEventListener('ended', () => audio.silentEl?.play().catch(() => {}));
      audio.silentEl.addEventListener('pause', () => {
        if (alarm.armed || audio.testing) audio.silentEl?.play().catch(() => {});
      });
    }
    audio.silentEl.play().catch(() => {});
  };

  const startKeepAlive = () => {
    if (audio.keepAlive) return;
    audio.keepAlive = setInterval(() => {
      const ctx = getCtx();
      if (!ctx) return;
      resumeCtx();
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        osc.start();
        osc.stop(ctx.currentTime + 0.05);
      } catch { /* ignore */ }
    }, 10_000);
  };

  const beep = (freq, dur, vol = 0.5, when) => {
    const ctx = getCtx(); if (!ctx) return;
    try {
      resumeCtx();
      const t = when ?? ctx.currentTime;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'square';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.start(t);
      o.stop(t + dur + 0.01);
    } catch { /* ignore */ }
  };

  const playAlarmPattern = () => {
    const ctx = getCtx(); if (!ctx) return;
    const t = ctx.currentTime;
    beep(1046, 0.14, 0.70, t);
    beep(1046, 0.14, 0.70, t + 0.20);
    beep(1046, 0.14, 0.70, t + 0.40);
    beep(1318, 0.30, 0.75, t + 0.65);
  };

  const startAlarmSound = (attempt = 1) => {
    if (attempt === 1 && audio.beepLoop) {
      clearInterval(audio.beepLoop); audio.beepLoop = null;
    }
    const ctx = getCtx(); if (!ctx) return;

    const beginLoop = () => {
      if (audio.beepLoop) { clearInterval(audio.beepLoop); audio.beepLoop = null; }
      playAlarmPattern();
      audio.beepLoop = setInterval(playAlarmPattern, 1400);
    };

    audio.silentEl?.play().catch(() => {});
    resumeCtx().then(() => {
      beginLoop();
      if (ctx.state !== 'running' && attempt < 4) {
        setTimeout(() => startAlarmSound(attempt + 1), 1000);
      }
    });
  };

  const stopAlarmSound = () => {
    if (audio.beepLoop) { clearInterval(audio.beepLoop); audio.beepLoop = null; }
    audio.testing = false;
    const btn = $('test-sound-btn');
    if (btn) btn.textContent = '🔊 Test Alarm Sound';
  };

  const enableAlarmSound = () => {
    if (!getCtx()) return;
    resumeCtx().then(() => {
      beep(880, 0.15, 0.3);
      startKeepAlive();
      playSilentLoop();
      const btn = $('enable-sound-btn');
      if (btn) {
        btn.textContent = '✅ Alarm Sound Enabled';
        btn.style.borderColor = 'var(--ok)';
        btn.style.color = 'var(--ok)';
      }
    });
  };

  const testAlarmSound = () => {
    if (!getCtx()) return;
    if (audio.testing) { stopAlarmSound(); return; }
    playSilentLoop();
    resumeCtx().then(() => {
      startKeepAlive();
      audio.testing = true;
      const btn = $('test-sound-btn');
      if (btn) btn.textContent = '⏹️ Stop Test Sound';
      startAlarmSound(1);
    });
  };

  // Unlock audio on the very first user gesture.
  const initAudioOnFirstGesture = () => {
    const unlock = () => {
      const ctx = getCtx(); if (!ctx) return;
      resumeCtx().then(startKeepAlive);
      document.removeEventListener('click', unlock);
      document.removeEventListener('touchstart', unlock);
    };
    document.addEventListener('click', unlock, { once: false });
    document.addEventListener('touchstart', unlock, { once: false });
  };
  initAudioOnFirstGesture();

  /* ──────────────────────────────────────────────────────────
     WAKE LOCK + BEDTIME
     ────────────────────────────────────────────────────────── */
  const wake = { lock: null };

  const requestWakeLock = async () => {
    if (!('wakeLock' in navigator)) return;
    try {
      wake.lock = await navigator.wakeLock.request('screen');
      wake.lock.addEventListener('release', () => { wake.lock = null; });
    } catch (err) {
      console.warn('Wake lock request failed:', err);
    }
  };

  const releaseWakeLock = () => {
    if (!wake.lock) return;
    try { wake.lock.release().then(() => { wake.lock = null; }); }
    catch { wake.lock = null; }
  };

  const enableBedtime = () => {
    $('bedtime-overlay')?.classList.add('active');
    requestWakeLock();
    resumeCtx().then(startKeepAlive);
    playSilentLoop();
  };
  const disableBedtime = () => {
    $('bedtime-overlay')?.classList.remove('active');
    if (!alarm.armed) releaseWakeLock();
  };

  /* ──────────────────────────────────────────────────────────
     NOTIFICATIONS (fallback wake nudge)
     ────────────────────────────────────────────────────────── */
  const requestNotificationPermission = () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  };
  const fireNotification = () => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    try {
      const n = new Notification('FIFO Countdown', {
        body: `Wake up — alarm set for ${fmt12(loadAlarm().time)}`,
        tag: 'fifo-alarm',
        requireInteraction: true,
        silent: false,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* ignore */ }
  };

  /* ──────────────────────────────────────────────────────────
     ALARM TRIGGER / STOP / SNOOZE
     ────────────────────────────────────────────────────────── */
  const alarm = {
    fired: false,
    snoozeTimer: null,
    snoozeUntil: null,
    lastTickKey: null, // 'YYYY-MM-DD HH:MM' that we last evaluated
    get armed() {
      const a = loadAlarm();
      return !!(a.on && a.time);
    },
  };

  const triggerAlarm = () => {
    if (alarm.fired) return;
    alarm.fired = true;

    disableBedtime();
    requestWakeLock();

    const now = new Date();
    const subtitle = `Alarm set for ${fmt12(loadAlarm().time)} — ${
      now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' })
    }`;
    $('alarm-alert-time').textContent = subtitle;
    $('alarm-alert').classList.add('active');
    document.body.style.overflow = 'hidden';

    startAlarmSound(1);
    fireNotification();
    if ('vibrate' in navigator) {
      try { navigator.vibrate([400, 200, 400, 200, 400]); } catch { /* ignore */ }
    }
  };

  const stopAlarm = () => {
    stopAlarmSound();
    $('alarm-alert').classList.remove('active');
    document.body.style.overflow = '';
    alarm.fired = false;
    alarm.snoozeUntil = null;
    if (alarm.snoozeTimer) { clearTimeout(alarm.snoozeTimer); alarm.snoozeTimer = null; }
    if (!$('bedtime-overlay')?.classList.contains('active')) releaseWakeLock();
    render();
    // Same-gesture deep-link to Spotify → wakes the user with their music.
    try { doOpenSpotify(null); } catch (_) {}
  };

  const snoozeAlarm = () => {
    stopAlarmSound();
    $('alarm-alert').classList.remove('active');
    document.body.style.overflow = '';
    alarm.fired = false;
    const mins = parseInt(loadAlarm().snooze, 10) || 10;
    alarm.snoozeUntil = Date.now() + mins * 60_000;
    if (alarm.snoozeTimer) clearTimeout(alarm.snoozeTimer);
    alarm.snoozeTimer = setTimeout(() => {
      alarm.snoozeUntil = null;
      triggerAlarm();
    }, mins * 60_000);
  };

  // Check every 5s while visible; also catches-up on visibility change.
  const checkAlarm = () => {
    if (alarm.snoozeUntil) {
      if (Date.now() >= alarm.snoozeUntil) {
        alarm.snoozeUntil = null;
        triggerAlarm();
      }
      return;
    }
    if (!alarm.armed) return;
    const a = loadAlarm();
    const now = new Date();
    const nowHM = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
    const tickKey = `${isoDate(now)} ${nowHM}`;

    if (nowHM === a.time && !alarm.fired && alarm.lastTickKey !== tickKey) {
      alarm.lastTickKey = tickKey;
      triggerAlarm();
    } else if (nowHM !== a.time && alarm.fired
               && !$('alarm-alert').classList.contains('active')) {
      alarm.fired = false;
    }
  };
  setInterval(checkAlarm, 5_000);

  /* ──────────────────────────────────────────────────────────
     SPOTIFY
     ────────────────────────────────────────────────────────── */
  const buildSpotifyUrls = (rawUrl) => {
    const web = (rawUrl || '').trim() || 'https://open.spotify.com';
    const m = web.match(/open\.spotify\.com\/(track|album|playlist|artist|show|episode)\/([A-Za-z0-9]+)/);
    const app = m ? `spotify:${m[1]}:${m[2]}` : 'spotify://';
    return { app, web };
  };

  const doOpenSpotify = (statusElId) => {
    const { app, web } = buildSpotifyUrls(loadSpotify().url);
    const el = statusElId ? $(statusElId) : null;
    if (el) { el.textContent = 'Opening Spotify…'; el.className = 'spotify-status ok'; }

    let appOpened = false;
    const onVis = () => { if (document.visibilityState === 'hidden') appOpened = true; };
    document.addEventListener('visibilitychange', onVis);

    window.location.href = app;
    setTimeout(() => {
      document.removeEventListener('visibilitychange', onVis);
      if (!appOpened) window.location.href = web;
      if (el) setTimeout(() => { el.textContent = ''; el.className = 'spotify-status'; }, 2000);
    }, 2500);
  };

  const openSpotify = () => doOpenSpotify(null);

  /* ──────────────────────────────────────────────────────────
     ROSTER-DERIVED STATE
     ────────────────────────────────────────────────────────── */
  /** Returns null when no roster is set. */
  const computeRosterState = (roster, now = today()) => {
    if (!roster) return null;
    const start    = parseDate(roster.startDate);
    const daysOn   = parseInt(roster.daysOn, 10);
    const daysOff  = parseInt(roster.daysOff, 10);
    const shiftType = roster.shiftType || 'day';
    const cycleLen = daysOn + daysOff;
    const elapsed  = diffDays(start, now);
    const cycles   = elapsed >= 0 ? Math.floor(elapsed / cycleLen) : 0;
    const curStart   = addDays(start, cycles * cycleLen);
    const curFlyHome = addDays(curStart, daysOn);
    const curEnd     = addDays(curStart, cycleLen);
    const isOnSwing  = (elapsed >= 0) && (now < curFlyHome);
    const daysLeft   = Math.max(0, diffDays(now, curFlyHome));
    const offGone    = isOnSwing ? 0 : diffDays(curFlyHome, now);
    const offLeft    = isOnSwing ? daysOff : Math.max(0, daysOff - offGone);
    const pct = isOnSwing
      ? Math.min(100, Math.round(((daysOn - daysLeft) / daysOn) * 100))
      : Math.min(100, Math.round((offGone / daysOff) * 100));
    return {
      start, daysOn, daysOff, cycleLen, shiftType,
      curStart, curFlyHome, curEnd,
      isOnSwing, daysLeft, offLeft, pct,
      nextSwing: isOnSwing ? null : curEnd,
    };
  };

  /** Day-status for a single date inside the roster pattern. */
  const dayStatus = (state, date) => {
    if (!state) return { kind: 'none' };
    const elapsed = diffDays(state.start, date);
    if (isNaN(elapsed)) return { kind: 'none' };
    const pos = ((elapsed % state.cycleLen) + state.cycleLen) % state.cycleLen;
    const onSwing = pos < state.daysOn;
    const isFlyHome = pos === state.daysOn - 1; // last day on site
    const isReturn  = pos === 0 && elapsed > 0; // fly back to site
    return { kind: onSwing ? 'on-site' : 'rr', isFlyHome, isReturn };
  };

  /* ──────────────────────────────────────────────────────────
     CALENDAR
     ────────────────────────────────────────────────────────── */
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const DOW    = ['S','M','T','W','T','F','S'];
  const WEEKEND = [0, 6]; // Sun, Sat

  const cal = { year: null, month: null };

  const initCalendarView = () => {
    if (cal.year === null || cal.month === null) {
      const now = today();
      cal.year = now.getFullYear();
      cal.month = now.getMonth();
    }
  };
  const shiftMonth = (delta) => {
    initCalendarView();
    let m = cal.month + delta;
    let y = cal.year;
    while (m < 0)  { m += 12; y--; }
    while (m > 11) { m -= 12; y++; }
    cal.month = m; cal.year = y;
    render();
  };
  const jumpToToday = () => {
    const now = today();
    cal.year = now.getFullYear();
    cal.month = now.getMonth();
    render();
  };

  const buildCalendar = () => {
    initCalendarView();
    const now = today();
    const roster = loadRoster();
    const state = computeRosterState(roster, now);
    const reminders = loadReminders();

    const firstDay = new Date(cal.year, cal.month, 1);
    const startingDow = firstDay.getDay();
    const totalDays = new Date(cal.year, cal.month + 1, 0).getDate();
    const onCurrentMonth = (cal.year === now.getFullYear() && cal.month === now.getMonth());

    let html = `
      <section class="cal-card" aria-label="Calendar">
        <header class="cal-head">
          <div class="cal-title-block">
            <h2 class="cal-title">
              <span class="cal-month">${MONTHS[cal.month]}</span>
              <span class="cal-year">${cal.year}</span>
            </h2>
            <div class="cal-sub" aria-hidden="true">Swipe ← → to change month</div>
          </div>
          ${onCurrentMonth ? '' : `<button class="cal-today-btn" data-action="cal-today" aria-label="Jump to today">Today</button>`}
        </header>
        <div class="cal-grid" role="grid" aria-label="${MONTHS[cal.month]} ${cal.year}">`;

    DOW.forEach((d, i) => {
      const cls = WEEKEND.includes(i) ? 'cal-dow weekend' : 'cal-dow';
      html += `<div class="${cls}" role="columnheader" aria-label="${d}">${d}</div>`;
    });
    for (let i = 0; i < startingDow; i++) {
      html += `<div class="cal-day empty" aria-hidden="true"></div>`;
    }

    for (let d = 1; d <= totalDays; d++) {
      const dObj = new Date(cal.year, cal.month, d);
      const dateStr = isoDate(dObj);
      const isToday = dObj.getTime() === now.getTime();
      const isWeekend = WEEKEND.includes(dObj.getDay());
      const status = dayStatus(state, dObj);
      const dayRems = reminders[dateStr] || [];
      const remCount = dayRems.length;
      // Reminder colour wins the tile — use the most recently added coloured reminder.
      let tileColorKey = null;
      for (let k = dayRems.length - 1; k >= 0; k--) {
        if (dayRems[k].color) { tileColorKey = dayRems[k].color; break; }
      }

      const cls = [
        'cal-day',
        status.kind === 'on-site' ? 'on-site' : status.kind === 'rr' ? 'rr' : '',
        isToday ? 'today' : '',
        status.isFlyHome ? 'fly-home' : '',
        isWeekend ? 'weekend' : '',
        tileColorKey ? 'has-rem-color' : '',
      ].filter(Boolean).join(' ');
      const tileStyle = tileColorKey
        ? ` style="--rem-bg:${REM_COLORS[tileColorKey].bg};--rem-fg:${REM_COLORS[tileColorKey].fg};"`
        : '';

      const remDot = remCount > 0
        ? `<span class="cal-rem${remCount > 1 ? ' multi' : ''}" aria-hidden="true"></span>`
        : '';
      const statusBar = status.kind === 'on-site' || status.kind === 'rr'
        ? `<span class="cal-bar" aria-hidden="true"></span>` : '';

      const parts = [
        dObj.toLocaleDateString('en-AU', { weekday:'long', day:'numeric', month:'long' }),
        isToday ? 'today' : '',
        status.kind === 'on-site' ? 'on site' : status.kind === 'rr' ? 'R and R' : '',
        status.isFlyHome ? 'fly home' : '',
        remCount ? `${remCount} reminder${remCount > 1 ? 's' : ''}` : '',
      ].filter(Boolean).join(', ');

      html += `<button class="${cls}"${tileStyle} data-action="cal-open" data-date="${dateStr}" aria-label="${parts}"><span class="cal-num">${d}</span>${statusBar}${remDot}</button>`;
    }

    html += '</div>';
    if (state) {
      html += `
        <div class="cal-legend" aria-label="Legend">
          <span class="lg-item"><span class="lg-swatch lg-on"></span>On site</span>
          <span class="lg-item"><span class="lg-swatch lg-rr"></span>R&amp;R</span>
          <span class="lg-item"><span class="lg-swatch lg-rem"></span>Reminder</span>
        </div>`;
    }
    html += '</section>';
    return html;
  };

  /* ──────────────────────────────────────────────────────────
     REMINDERS SUBPANEL
     ────────────────────────────────────────────────────────── */
  const openRemindersSub = (dateStr) => {
    const list = loadReminders()[dateStr] || [];
    remPickerColor = null;
    const [y, m, d] = dateStr.split('-');
    const display = new Date(+y, +m - 1, +d).toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
    });

    let h = `
      <div class="panel-handle"></div>
      <div class="panel-title">📅 Reminders</div>
      <button class="sub-back-btn" data-action="close-panel">Close</button>
      <div class="p-section-head">${esc(display)}</div>`;

    if (list.length === 0) {
      h += `<div class="rem-empty">No reminders set for this date.</div>`;
    } else {
      h += `<div class="rem-list">`;
      list.forEach((rem, i) => {
        const swatches = REM_COLOR_KEYS.map((k) => {
          const sel = rem.color === k ? ' selected' : '';
          return `<button type="button" class="rem-swatch${sel}" data-action="rem-color" data-date="${dateStr}" data-i="${i}" data-color="${k}" aria-label="${REM_COLORS[k].label}" style="background:${REM_COLORS[k].bg};"></button>`;
        }).join('');
        const noneSel = rem.color ? '' : ' selected';
        const noneBtn = `<button type="button" class="rem-swatch rem-swatch-none${noneSel}" data-action="rem-color" data-date="${dateStr}" data-i="${i}" data-color="" aria-label="No colour">✕</button>`;
        h += `
          <div class="rem-item">
            <div class="rem-item-row">
              <span class="rem-text">${esc(rem.text)}</span>
              <button class="rem-del" data-action="rem-del" data-date="${dateStr}" data-i="${i}" aria-label="Delete reminder">🗑️</button>
            </div>
            <div class="rem-swatches" role="group" aria-label="Tile colour">${swatches}${noneBtn}</div>
          </div>`;
      });
      h += `</div>`;
    }

    h += `
      <div class="p-divider"></div>
      <div class="form-group">
        <label for="reminder-input">Add new reminder</label>
        <div class="rem-add-row">
          <input type="text" id="reminder-input" class="rem-add-input"
                 placeholder="e.g. Flight 10:30am, Birthday…" maxlength="120"
                 data-action="rem-input" data-date="${dateStr}">
          <button class="rem-add-btn" data-action="rem-add" data-date="${dateStr}">Add</button>
        </div>
        <div class="rem-swatches rem-swatches-new" role="group" aria-label="Tile colour for new reminder">
          ${REM_COLOR_KEYS.map((k) => `<button type="button" class="rem-swatch" data-action="rem-pick-color" data-color="${k}" aria-label="${REM_COLORS[k].label}" style="background:${REM_COLORS[k].bg};"></button>`).join('')}
          <button type="button" class="rem-swatch rem-swatch-none selected" data-action="rem-pick-color" data-color="" aria-label="No colour">✕</button>
        </div>
      </div>`;

    $('settings-panel').innerHTML = h;
    $('overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('reminder-input')?.focus(), 50);
  };

  const addReminder = (dateStr) => {
    const input = $('reminder-input');
    const text = (input?.value || '').trim();
    if (!text) return;
    const rems = loadReminders();
    (rems[dateStr] ||= []).push({ text, color: remPickerColor || null });
    saveReminders(rems);
    openRemindersSub(dateStr);
    render();
  };

  const deleteReminder = (dateStr, index) => {
    const rems = loadReminders();
    if (!rems[dateStr]) return;
    rems[dateStr].splice(index, 1);
    if (rems[dateStr].length === 0) delete rems[dateStr];
    saveReminders(rems);
    openRemindersSub(dateStr);
    render();
  };

  const setReminderColor = (dateStr, index, colorKey) => {
    const rems = loadReminders();
    if (!rems[dateStr] || !rems[dateStr][index]) return;
    rems[dateStr][index].color = colorKey && REM_COLORS[colorKey] ? colorKey : null;
    saveReminders(rems);
    openRemindersSub(dateStr);
    render();
  };

  const pickRemColor = (colorKey) => {
    remPickerColor = colorKey && REM_COLORS[colorKey] ? colorKey : null;
    // Visually mark the selected swatch without re-rendering the whole panel.
    const row = document.querySelector('.rem-swatches-new');
    if (!row) return;
    row.querySelectorAll('.rem-swatch').forEach((el) => {
      const v = el.dataset.color || '';
      el.classList.toggle('selected', v === (remPickerColor || ''));
    });
  };

  /* ──────────────────────────────────────────────────────────
     ALARM STATUS LINE
     ────────────────────────────────────────────────────────── */
  const renderAlarmStatus = () => {
    const el = $('alarm-status-line');
    if (!el) return;
    const a = loadAlarm();
    if (a.on && a.time) {
      el.innerHTML = `<span class="alarm-status-dot"></span>Alarm: ${fmt12(a.time)} · Snooze: ${a.snooze || 10} min`;
      el.classList.remove('hidden');
    } else {
      el.innerHTML = '';
      el.classList.add('hidden');
    }
  };

  /* ──────────────────────────────────────────────────────────
     BACKUP / RESTORE
     ────────────────────────────────────────────────────────── */
  const exportBackup = () => {
    const backup = {};
    for (const [k, lsKey] of Object.entries(KEYS)) {
      backup[k] = localStorage.getItem(lsKey);
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'fifo_countdown_backup.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  };

  const importBackup = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        // Accept both new shape (keyed by short name) and legacy shape.
        const legacy = { roster: 'roster', alarm: 'alarm', spotify: 'spotify',
                         dontForget: 'dont_forget', notes: 'notes', reminders: 'reminders' };
        for (const [short, lsKey] of Object.entries(KEYS)) {
          const value = data[short] ?? data[legacy[short]];
          if (value) localStorage.setItem(lsKey, value);
        }
        alert('Backup loaded successfully!');
        window.location.reload();
      } catch {
        alert("Error parsing backup file. Please make sure it's a valid backup JSON.");
      }
    };
    reader.readAsText(file);
  };

  /* ──────────────────────────────────────────────────────────
     MAIN RENDER
     ────────────────────────────────────────────────────────── */
  const render = () => {
    const roster = loadRoster();
    const el = $('main-content');

    if (!roster) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⛏️</div>
          <div class="empty-title">Set up your roster</div>
          <div class="empty-sub">Enter your swing start date and roster pattern to start counting down.</div>
          <button class="cta-btn" data-action="open-panel">Enter Roster Details</button>
        </div>
        ${buildCalendar()}
        <div class="alarm-status-row hidden" id="alarm-status-line"></div>`;
      renderAlarmStatus();
      return;
    }

    const state = computeRosterState(roster);
    const { daysOn, daysOff, isOnSwing, curFlyHome, daysLeft, offLeft, pct,
            shiftType, nextSwing, curEnd } = state;
    const heroNum = isOnSwing ? daysLeft : offLeft;
    const hc = isOnSwing ? (daysLeft <= 2 ? 'danger' : '') : 'done';
    const pbClass = isOnSwing ? '' : 'done';
    const now = today();

    const formatDateLong = (d) => {
      const wk = d.toLocaleDateString('en-AU', { weekday: 'long' });
      const rest = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
      return `${wk} &middot; ${rest}`;
    };
    const nextDate = isOnSwing ? curFlyHome : (nextSwing || curFlyHome);
    const nextLabel = isOnSwing
      ? (daysLeft === 0 ? '✈ Flying home today' : '✈ Fly home')
      : '⛏ Next swing';

    // --- Card 1: Countdown ---
    const cardCountdown = `
      <article class="hero-card hero premium ${isOnSwing ? '' : 'on-rr'}">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="hero-shine" aria-hidden="true"></div>
        <div class="hero-badge ${isOnSwing ? 'on-site' : 'on-rr'}">
          <span class="hero-badge-dot"></span>${isOnSwing ? 'On Site' : 'On R&R'}
        </div>
        <div class="hero-label">${isOnSwing ? 'Days left on site' : 'Days left at home'}</div>
        <div class="hero-number-wrap">
          <div class="hero-number ${hc}" style="--fill:${pct}%">${heroNum}</div>
          <div class="hero-unit">${heroNum === 1 ? 'day' : 'days'} remaining</div>
        </div>
        <div class="hero-next">
          <div class="hero-next-label">${nextLabel}</div>
          <div class="hero-next-date">${formatDateLong(nextDate)}</div>
        </div>
        <div class="hero-progress">
          <div class="progress-wrap premium"><div class="progress-fill ${pbClass}" style="width:${pct}%"></div></div>
          <div class="progress-label">
            <span>${isOnSwing ? 'Day 1' : 'Home'}</span>
            <span class="pct">${pct}%</span>
            <span>${isOnSwing ? 'Day ' + daysOn : 'Site'}</span>
          </div>
        </div>
      </article>`;

    // --- Card 2: Travel ---
    const flyHomeDate = curFlyHome;
    const returnDate  = isOnSwing ? addDays(curFlyHome, daysOff) : (nextSwing || curEnd);
    const flyHomeIn   = isOnSwing ? daysLeft : 0;
    const returnIn    = isOnSwing ? daysLeft + daysOff : offLeft;
    // Next journey depends on where you are now
    const nextIsHome  = isOnSwing;
    const nextDateT   = nextIsHome ? flyHomeDate : returnDate;
    const nextInT     = nextIsHome ? flyHomeIn   : returnIn;
    const nextLabelT  = nextIsHome ? 'Fly Home'  : 'Return to Site';
    const nextClassT  = nextIsHome ? 'accent'    : 'ok';
    const badgeClassT = nextIsHome ? 'on-site'   : 'on-rr';
    const badgeTextT  = nextIsHome ? 'Next Flight' : 'Home';

    const flight = readJSON(KEYS.flight, { number: '', time: '', from: '', to: '', terminal: '', airline: '' });
    const hasFlight = !!(flight.number || flight.time || flight.from || flight.to || flight.terminal || flight.airline);

    const flightDetailsBody = hasFlight ? `
      <div class="flight-grid">
        ${flight.airline ? `<div class="flight-cell"><div class="flight-k">Airline</div><div class="flight-v">${esc(flight.airline)}</div></div>` : ''}
        ${flight.number  ? `<div class="flight-cell"><div class="flight-k">Flight</div><div class="flight-v mono">${esc(flight.number)}</div></div>` : ''}
        ${flight.time    ? `<div class="flight-cell"><div class="flight-k">Departs</div><div class="flight-v mono">${esc(flight.time)}</div></div>` : ''}
        ${flight.terminal? `<div class="flight-cell"><div class="flight-k">Terminal</div><div class="flight-v mono">${esc(flight.terminal)}</div></div>` : ''}
        ${(flight.from || flight.to) ? `
          <div class="flight-route">
            <span class="flight-code">${esc(flight.from || '—')}</span>
            <span class="flight-arrow" aria-hidden="true">→</span>
            <span class="flight-code">${esc(flight.to || '—')}</span>
          </div>` : ''}
      </div>
      <div class="flight-edit-hint">Tap to edit</div>
    ` : `
      <div class="flight-empty">
        <span class="flight-empty-icon">✈️</span>
        <span>Tap to add flight details</span>
      </div>`;

    const cardTravel = `
      <article class="hero-card travel-card premium">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="hero-shine" aria-hidden="true"></div>
        <div class="hero-badge ${badgeClassT}">
          <span class="hero-badge-dot"></span>${badgeTextT}
        </div>
        <div class="hero-card-title">✈️ Travel</div>

        <div class="travel-hero">
          <div class="travel-hero-label">${nextLabelT}</div>
          <div class="travel-hero-num ${nextClassT}">
            ${nextInT === 0 ? '<span class="today">TODAY</span>' : nextInT}
            ${nextInT > 0 ? `<span class="travel-hero-unit">day${nextInT === 1 ? '' : 's'}</span>` : ''}
          </div>
          <div class="travel-hero-date">${formatDateLong(nextDateT)}</div>
        </div>

        <div class="travel-timeline">
          <div class="tl-row">
            <div class="tl-dot accent"></div>
            <div class="tl-content">
              <div class="tl-label">Fly Home</div>
              <div class="tl-date">${formatDate(flyHomeDate)}</div>
            </div>
            <div class="tl-meta">${isOnSwing
                ? (flyHomeIn === 0 ? 'Today' : `in ${flyHomeIn}d`)
                : 'Done'}</div>
          </div>
          <div class="tl-line"></div>
          <div class="tl-row">
            <div class="tl-dot ok"></div>
            <div class="tl-content">
              <div class="tl-label">Return to Site</div>
              <div class="tl-date">${formatDate(returnDate)}</div>
            </div>
            <div class="tl-meta">in ${returnIn}d</div>
          </div>
        </div>

        <button class="flight-details ${hasFlight ? 'has-data' : ''}" data-action="edit-flight" aria-label="Edit flight details">
          <div class="flight-details-head">
            <span class="flight-details-title">Flight Details</span>
            <span class="flight-details-chev">${hasFlight ? '✎' : '＋'}</span>
          </div>
          ${flightDetailsBody}
        </button>

        ${shiftType ? `<div class="travel-foot">${shiftType === 'night' ? '🌙 Night shift rotation' : '☀️ Day shift rotation'}</div>` : ''}
      </article>`;

    // --- Card 3: Planner ---
    const notesText  = localStorage.getItem(KEYS.notes) || '';
    const dfText     = localStorage.getItem(KEYS.dontForget) || '';
    const dfItems    = dfText.split('\n').map(s => s.trim()).filter(Boolean);
    const notesPrev  = notesText.trim().slice(0, 140);
    const cardPlanner = `
      <article class="hero-card planner-card">
        <div class="hero-card-title">📝 Planner</div>
        <button class="planner-block" data-action="open-notes-from-hero">
          <div class="planner-block-head">
            <span>Notes</span>
            <span class="planner-chev">›</span>
          </div>
          <div class="planner-block-body">${
            notesPrev ? esc(notesPrev) + (notesText.length > 140 ? '…' : '') : '<em>Tap to add notes for this swing</em>'
          }</div>
        </button>
        <button class="planner-block" data-action="open-df-from-hero">
          <div class="planner-block-head">
            <span>Checklist</span>
            <span class="planner-count">${dfItems.length} item${dfItems.length === 1 ? '' : 's'}</span>
            <span class="planner-chev">›</span>
          </div>
          <div class="planner-block-body">${
            dfItems.length
              ? dfItems.slice(0, 3).map(s => `• ${esc(s.replace(/^[•\-\*]\s*/, ''))}`).join('<br>')
                  + (dfItems.length > 3 ? `<br><span class="muted">+${dfItems.length - 3} more</span>` : '')
              : '<em>Tap to add packing & check-in items</em>'
          }</div>
        </button>
      </article>`;

    const cards = [cardCountdown, cardTravel, cardPlanner];
    const carousel = `
      <section class="hero-carousel-wrap" aria-label="Dashboard">
        <div class="hero-carousel" id="hero-carousel" role="region" aria-roledescription="carousel">
          ${cards.map((c, i) => `<div class="hero-slide" data-idx="${i}">${c}</div>`).join('')}
        </div>
        <div class="hero-dots" id="hero-dots" role="tablist">
          ${cards.map((_, i) => `<button class="hero-dot${i === 0 ? ' active' : ''}" data-action="hero-dot" data-idx="${i}" aria-label="Card ${i + 1}"></button>`).join('')}
        </div>
      </section>`;

    el.innerHTML = `
      ${carousel}
      ${buildCalendar()}
      <div class="alarm-status-row hidden" id="alarm-status-line"></div>`;

    renderAlarmStatus();
    setupHeroCarousel();
  };

  /* ──────────────────────────────────────────────────────────
     SETTINGS PANEL
     ────────────────────────────────────────────────────────── */
  const openPanel = () => {
    renderSettingsMenu();
    $('overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
  };
  const closePanel = () => {
    stopAlarmSound();
    $('overlay').classList.remove('open');
    document.body.style.overflow = '';
  };

  /* ──────────────────────────────────────────────────────────
     HERO CAROUSEL — scroll-snap with dot indicators
     Always opens on slide 0. Swipe is native horizontal scroll.
     ────────────────────────────────────────────────────────── */
  const setupHeroCarousel = () => {
    const car = $('hero-carousel');
    const dots = $('hero-dots');
    if (!car || !dots) return;
    car.scrollLeft = 0;
    let raf = null;
    const updateDots = () => {
      const w = car.clientWidth || 1;
      const idx = Math.round(car.scrollLeft / w);
      dots.querySelectorAll('.hero-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
    };
    car.addEventListener('scroll', () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(updateDots);
    }, { passive: true });
  };
  const goHeroSlide = (idx) => {
    const car = $('hero-carousel');
    if (!car) return;
    car.scrollTo({ left: car.clientWidth * idx, behavior: 'smooth' });
  };

  const menuBtn = (icon, label, sub, action) => `
    <button class="settings-menu-btn" data-action="${action}">
      <span class="smb-icon">${icon}</span>
      <span class="smb-label-wrap">
        <span>${label}</span>
        <span class="smb-sub">${sub}</span>
      </span>
      <span class="smb-chev">›</span>
    </button>`;

  const renderSettingsMenu = () => {
    stopAlarmSound();
    const a = loadAlarm();
    const sp = loadSpotify();
    const alarmSub = a.on ? `Alarm on · ${fmt12(a.time)}` : 'Alarm off';
    const spSub    = sp.url ? 'Link saved' : 'No link saved';

    $('settings-panel').innerHTML = `
      <div class="panel-handle"></div>
      <div class="panel-title">Settings</div>
      ${menuBtn('📅', 'Roster &amp; Shift', 'Swing dates, shifts &amp; pattern', 'open-roster')}
      ${menuBtn('⏰', 'Alarm', alarmSub, 'open-alarm')}
      ${menuBtn('🎵', 'Spotify', spSub, 'open-spotify-sub')}`;
  };

  /* ── Roster subpage */
  const openSubRoster = () => {
    const r = loadRoster();
    let startVal = '', onVal = '14', offVal = '7', shiftVal = 'day';
    if (r) { startVal = r.startDate; onVal = r.daysOn; offVal = r.daysOff; shiftVal = r.shiftType || 'day'; }
    else { startVal = isoDate(new Date()); }

    $('settings-panel').innerHTML = `
      <div class="panel-handle"></div>
      <div class="panel-title">📅 Roster &amp; Shift</div>
      <button class="sub-back-btn" data-action="back-to-menu">Back to Settings</button>
      <div class="p-section-head">Swing Start Date</div>
      <div class="form-group">
        <label for="startDate">First day on site</label>
        <input type="date" id="startDate" value="${startVal}">
      </div>
      <div class="p-divider"></div>
      <div class="p-section-head">Shift Type</div>
      <div class="form-group">
        <label for="shiftType">Day or Night rotation</label>
        <select id="shiftType">
          <option value="day"   ${shiftVal === 'day'   ? 'selected' : ''}>☀️ Day Shift</option>
          <option value="night" ${shiftVal === 'night' ? 'selected' : ''}>🌙 Night Shift</option>
        </select>
      </div>
      <div class="p-divider"></div>
      <div class="p-section-head">Roster Pattern</div>
      <div class="form-group">
        <label for="daysOn">Days ON</label>
        <div class="stepper">
          <button class="step-btn" data-action="step" data-target="daysOn" data-delta="-1">−</button>
          <input type="number" id="daysOn" min="1" max="365" value="${onVal}">
          <button class="step-btn" data-action="step" data-target="daysOn" data-delta="1">+</button>
        </div>
      </div>
      <div class="form-group">
        <label for="daysOff">Days OFF</label>
        <div class="stepper">
          <button class="step-btn" data-action="step" data-target="daysOff" data-delta="-1">−</button>
          <input type="number" id="daysOff" min="1" max="365" value="${offVal}">
          <button class="step-btn" data-action="step" data-target="daysOff" data-delta="1">+</button>
        </div>
      </div>
      <button class="save-btn" data-action="save-roster">Save Roster</button>
      <button class="clear-btn" data-action="clear-roster">Clear Roster</button>`;
  };

  const saveRosterSub = () => {
    const s = $('startDate').value;
    const shift = $('shiftType').value;
    const on  = parseInt($('daysOn').value, 10);
    const off = parseInt($('daysOff').value, 10);
    if (!s)         return showPanelMsg('Please enter your swing start date.');
    if (!on  || on  < 1) return showPanelMsg('Days ON must be at least 1.');
    if (!off || off < 1) return showPanelMsg('Days OFF must be at least 1.');
    saveRoster({ startDate: s, daysOn: on, daysOff: off, shiftType: shift });
    render();
    renderSettingsMenu();
  };
  const clearRosterSub = () => {
    if (!confirm('Clear your roster details?')) return;
    localStorage.removeItem(KEYS.roster);
    render();
    renderSettingsMenu();
  };

  /* ── Alarm subpage */
  const openSubAlarm = () => {
    const a = loadAlarm();
    const snooze = parseInt(a.snooze, 10) || 10;
    const pill = (mins) => snooze === mins ? 'active' : '';

    $('settings-panel').innerHTML = `
      <div class="panel-handle"></div>
      <div class="panel-title">⏰ Alarm</div>
      <button class="sub-back-btn" data-action="back-to-menu">Back to Settings</button>
      <div class="panel-row">
        <div>
          <div class="panel-row-label">Wake-up Alarm</div>
          <div class="panel-row-sub" id="alarm-toggle-sub">
            ${a.on ? `Rings at ${fmt12(a.time)} daily` : 'Off'}
          </div>
        </div>
        <div class="toggle-inline">
          <span class="toggle-status ${a.on ? 'on' : ''}" id="alarm-toggle-label">${a.on ? 'ON' : 'OFF'}</span>
          <label class="toggle">
            <input type="checkbox" id="alarm-toggle" ${a.on ? 'checked' : ''} data-action="toggle-alarm">
            <div class="toggle-track"></div>
            <div class="toggle-thumb"></div>
          </label>
        </div>
      </div>
      <div class="form-group">
        <label for="alarm-time-input">Wake-up time</label>
        <input type="time" class="time-input" id="alarm-time-input" value="${a.time || '06:00'}">
      </div>
      <div class="form-group">
        <label>Snooze duration</label>
        <div class="snooze-pills">
          <button type="button" class="snooze-pill ${pill(5)}"  data-action="snooze-pick" data-min="5">5 min</button>
          <button type="button" class="snooze-pill ${pill(10)}" data-action="snooze-pick" data-min="10">10 min</button>
          <button type="button" class="snooze-pill ${pill(15)}" data-action="snooze-pick" data-min="15">15 min</button>
        </div>
      </div>
      <button class="panel-save-btn" data-action="save-alarm">Save Alarm</button>
      <div id="alarm-sub-msg" class="panel-msg"></div>
      <div class="p-divider"></div>
      <div class="p-section-head">Alarm Sound &amp; Reliability</div>
      <div class="form-group btn-stack">
        <button type="button" class="panel-save-notes-btn" id="enable-sound-btn" data-action="enable-sound">🔊 Enable Alarm Sound</button>
        <button type="button" class="panel-save-notes-btn" id="test-sound-btn"   data-action="test-sound">🔊 Test Alarm Sound</button>
        <button type="button" class="panel-save-notes-btn" data-action="enable-notifications">🔔 Enable Notifications (fallback)</button>
      </div>`;

    setTimeout(() => {
      const ctx = getCtx();
      if (ctx && ctx.state === 'running') {
        const btn = $('enable-sound-btn');
        if (btn) {
          btn.textContent = '✅ Alarm Sound Enabled';
          btn.style.borderColor = 'var(--ok)';
          btn.style.color = 'var(--ok)';
        }
      }
    }, 50);
  };

  const toggleAlarmCheckbox = (on) => {
    const a = loadAlarm(); a.on = on; saveAlarm(a);
    const lbl = $('alarm-toggle-label');
    const sub = $('alarm-toggle-sub');
    if (lbl) { lbl.textContent = on ? 'ON' : 'OFF'; lbl.className = `toggle-status${on ? ' on' : ''}`; }
    if (sub) { sub.textContent = on ? `Rings at ${fmt12(a.time)} daily` : 'Off'; }
    if (!on) {
      alarm.fired = false; alarm.snoozeUntil = null;
      if (alarm.snoozeTimer) { clearTimeout(alarm.snoozeTimer); alarm.snoozeTimer = null; }
    } else {
      resumeCtx().then(startKeepAlive);
      playSilentLoop();
      requestNotificationPermission();
    }
    renderAlarmStatus();
  };

  const selectSnoozePill = (mins) => {
    document.querySelectorAll('.snooze-pill').forEach((p) => {
      p.classList.toggle('active', parseInt(p.dataset.min, 10) === mins);
    });
    const a = loadAlarm(); a.snooze = mins; saveAlarm(a);
  };

  const saveAlarmSub = () => {
    const t = $('alarm-time-input').value;
    if (!t) return showPanelMsg('Please pick a wake-up time.');
    const a = loadAlarm();
    a.time = t;
    a.on = $('alarm-toggle').checked;
    const activePill = document.querySelector('.snooze-pill.active');
    a.snooze = activePill ? parseInt(activePill.dataset.min, 10) : (a.snooze || 10);
    saveAlarm(a);
    alarm.fired = false;
    alarm.snoozeUntil = null;
    if (alarm.snoozeTimer) { clearTimeout(alarm.snoozeTimer); alarm.snoozeTimer = null; }
    renderAlarmStatus();
    resumeCtx().then(startKeepAlive);
    playSilentLoop();
    requestNotificationPermission();
    const msg = $('alarm-sub-msg');
    if (msg) { msg.textContent = '✓ Alarm saved'; setTimeout(() => { msg.textContent = ''; }, 2000); }
  };

  /* ── Spotify subpage */
  const openSubSpotify = () => {
    const sp = loadSpotify();
    $('settings-panel').innerHTML = `
      <div class="panel-handle"></div>
      <div class="panel-title">🎵 Spotify</div>
      <button class="sub-back-btn" data-action="back-to-menu">Back to Settings</button>
      <div class="form-group tight">
        <label for="spotify-url-input">Playlist, album, or track link</label>
        <input type="url" class="spotify-url-input" id="spotify-url-input"
               placeholder="https://open.spotify.com/playlist/…" value="${esc(sp.url || '')}">
      </div>
      <div class="form-group tight">
        <button class="spotify-test-btn" data-action="test-spotify">🎵 Test — Open Spotify Now</button>
      </div>
      <button class="panel-save-btn spotify-save" data-action="save-spotify">💾 Save Spotify Link</button>
      <div class="spotify-status" id="spotify-status"></div>`;
  };

  const testSpotifyLink = () => {
    const url = ($('spotify-url-input')?.value || '').trim();
    if (url) saveSpotify({ url });
    doOpenSpotify('spotify-status');
  };
  const saveSpotifySub = () => {
    const url = ($('spotify-url-input')?.value || '').trim();
    saveSpotify({ url });
    const s = $('spotify-status');
    if (s) {
      s.textContent = url ? '✓ Saved' : 'Cleared';
      s.className = `spotify-status${url ? ' ok' : ''}`;
      setTimeout(() => { s.textContent = ''; s.className = 'spotify-status'; }, 2500);
    }
  };

  /* ── Text-area subpages (don't-forget, notes) */
  const makeTextareaSub = ({ title, key, placeholder, btnLabel, btnId, taId }) => () => {
    const saved = localStorage.getItem(key) || '';
    $('settings-panel').innerHTML = `
      <div class="panel-handle"></div>
      <div class="panel-title">${title}</div>
      <button class="sub-back-btn" data-action="back-to-menu">Back to Settings</button>
      <div class="form-group" style="margin-bottom:10px;">
        <textarea id="${taId}" class="panel-textarea" data-action="autosave-text"
                  data-key="${key}" data-btn="${btnId}" placeholder="${placeholder}"></textarea>
      </div>
      <button class="panel-save-notes-btn" id="${btnId}" data-action="save-text"
              data-key="${key}" data-ta="${taId}">${btnLabel}</button>`;
    const ta = $(taId); if (ta) ta.value = saved;
  };

  const openSubDontForget = makeTextareaSub({
    title: "📌 Don't Forget List",
    key: KEYS.dontForget,
    placeholder: "• Flight check-in\n• Site access card\n• Chargers\n• Medications\n• Don't get lost",
    btnLabel: '💾 Save List',
    btnId: 'dont-forget-save-btn',
    taId: 'dont-forget-textarea',
  });
  const openSubNotes = makeTextareaSub({
    title: '📝 Notes',
    key: KEYS.notes,
    placeholder: 'Notes for this swing…',
    btnLabel: '💾 Save Notes',
    btnId: 'notes-save-btn',
    taId: 'notes-textarea',
  });

  const autosaveTimers = new Map();
  const autosaveText = (key, btnId, taId) => {
    if (autosaveTimers.has(key)) clearTimeout(autosaveTimers.get(key));
    autosaveTimers.set(key, setTimeout(() => saveText(key, taId, btnId, true), 800));
  };
  const saveText = (key, taId, btnId, silent) => {
    const ta = $(taId); if (!ta) return;
    localStorage.setItem(key, ta.value);
    const btn = $(btnId);
    if (!silent && btn) {
      const orig = btn.textContent;
      btn.textContent = '✓ Saved';
      btn.classList.add('saved');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('saved'); }, 1800);
    }
  };

  /* ── Backup subpage */
  const openSubBackup = () => {
    $('settings-panel').innerHTML = `
      <div class="panel-handle"></div>
      <div class="panel-title">💾 Backup &amp; Restore</div>
      <button class="sub-back-btn" data-action="back-to-menu">Back to Settings</button>
      <div class="p-section-head">Export Backup</div>
      <div class="form-group">
        <button class="panel-save-notes-btn" style="margin:0;width:100%;" data-action="export-backup">📤 Export Data to File</button>
      </div>
      <div class="p-divider"></div>
      <div class="p-section-head">Import Backup</div>
      <div class="form-group">
        <label for="import-file-input" class="panel-save-notes-btn" style="cursor:pointer;">📥 Select Backup File</label>
        <input type="file" id="import-file-input" accept=".json" class="visually-hidden" data-action="import-backup">
      </div>`;
  };

  /* ── Utility: stepper + messages */
  const step = (id, delta) => {
    const el = $(id);
    const v = parseInt(el.value, 10) || 0;
    const min = parseInt(el.min, 10) || 1;
    const max = parseInt(el.max, 10) || 365;
    el.value = Math.max(min, Math.min(max, v + delta));
  };

  const showPanelMsg = (msg) => {
    document.getElementById('_panel_err')?.remove();
    const d = document.createElement('div');
    d.id = '_panel_err';
    d.className = 'panel-msg err';
    d.textContent = msg;
    $('settings-panel')?.appendChild(d);
  };

  /* ──────────────────────────────────────────────────────────
     EVENT DELEGATION
     ────────────────────────────────────────────────────────── */
  const actions = {
    // Header
    'enable-bedtime':   enableBedtime,
    'disable-bedtime':  disableBedtime,
    'open-panel':       openPanel,
    'close-panel':      closePanel,
    'back-to-menu':     renderSettingsMenu,

    // Calendar
    'cal-prev':  () => shiftMonth(-1),
    'cal-next':  () => shiftMonth(1),
    'cal-today': jumpToToday,
    'cal-open':  (t) => openRemindersSub(t.dataset.date),

    // Reminders
    'rem-add': (t) => addReminder(t.dataset.date),
    'rem-del': (t) => deleteReminder(t.dataset.date, parseInt(t.dataset.i, 10)),
    'rem-color': (t) => setReminderColor(t.dataset.date, parseInt(t.dataset.i, 10), t.dataset.color),
    'rem-pick-color': (t) => pickRemColor(t.dataset.color),

    // Alarm overlay buttons
    'stop-alarm':   stopAlarm,
    'snooze-alarm': snoozeAlarm,
    'open-spotify': openSpotify,

    // Settings menu
    'open-roster':      openSubRoster,
    'open-alarm':       openSubAlarm,
    'open-spotify-sub': openSubSpotify,
    'open-dont-forget': openSubDontForget,
    'open-notes':       openSubNotes,
    'open-backup':      openSubBackup,

    // Hero carousel
    'hero-dot': (t) => goHeroSlide(parseInt(t.dataset.idx, 10)),
    'open-alarm-from-hero': () => { openPanel(); openSubAlarm(); },
    'open-notes-from-hero': () => { openPanel(); openSubNotes(); },
    'open-df-from-hero':    () => { openPanel(); openSubDontForget(); },
    'edit-flight':          editFlightDetails,

    // Roster
    'save-roster':  saveRosterSub,
    'clear-roster': clearRosterSub,
    'step': (t) => step(t.dataset.target, parseInt(t.dataset.delta, 10)),

    // Alarm subpage
    'save-alarm':   saveAlarmSub,
    'snooze-pick':  (t) => selectSnoozePill(parseInt(t.dataset.min, 10)),
    'enable-sound': enableAlarmSound,
    'test-sound':   testAlarmSound,
    'enable-notifications': requestNotificationPermission,

    // Spotify
    'test-spotify': testSpotifyLink,
    'save-spotify': saveSpotifySub,

    // Text saves
    'save-text': (t) => saveText(t.dataset.key, t.dataset.ta, t.dataset.key === KEYS.dontForget ? 'dont-forget-save-btn' : 'notes-save-btn', false),

    // Backup
    'export-backup': exportBackup,
  };

  // Click delegation
  document.addEventListener('click', (ev) => {
    const target = ev.target.closest('[data-action]');
    if (!target) return;
    // Bedtime overlay should only close on its own background, not on its text children
    if (target.dataset.action === 'disable-bedtime' && ev.target !== target) return;
    actions[target.dataset.action]?.(target, ev);
  });

  // Overlay click-to-close
  document.addEventListener('click', (ev) => {
    if (ev.target.id === 'overlay') closePanel();
  });

  // Toggle / change events
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'alarm-toggle')        toggleAlarmCheckbox(t.checked);
    if (t.id === 'import-file-input')   importBackup(ev);
  });

  // Reminder input "Enter to add" + textarea autosave
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target?.id === 'reminder-input') {
      addReminder(ev.target.dataset.date);
    }
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset?.action === 'autosave-text') autosaveText(t.dataset.key, t.dataset.btn, t.id);
  });

  // Calendar swipe nav (left/right) on .cal-grid
  let touchStartX = null, touchStartY = null;
  document.addEventListener('touchstart', (ev) => {
    const grid = ev.target.closest('.cal-grid');
    if (!grid) return;
    const tch = ev.changedTouches[0];
    touchStartX = tch.clientX; touchStartY = tch.clientY;
  }, { passive: true });
  document.addEventListener('touchend', (ev) => {
    if (touchStartX === null) return;
    const grid = ev.target.closest('.cal-grid');
    const tch = ev.changedTouches[0];
    const dx = tch.clientX - touchStartX;
    const dy = tch.clientY - touchStartY;
    touchStartX = touchStartY = null;
    if (!grid) return;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      shiftMonth(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  /* ──────────────────────────────────────────────────────────
     VISIBILITY / RESUME — alarm reliability layer
     ────────────────────────────────────────────────────────── */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;

    // Re-acquire wake lock if bedtime is on
    if ($('bedtime-overlay')?.classList.contains('active')) requestWakeLock();

    // Resume audio session that the OS may have suspended
    if (alarm.armed || audio.testing) {
      resumeCtx();
      playSilentLoop();
    }

    // Catch-up: did we miss the alarm while the tab was hidden?
    const a = loadAlarm();
    if (a.on && a.time) {
      const now = new Date();
      const todayKey = isoDate(now);
      const [hh, mm] = a.time.split(':').map(Number);
      const alarmTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm).getTime();
      // If alarm time has passed within the last 60 minutes and we haven't fired today, fire now.
      const sinceAlarm = now.getTime() - alarmTs;
      const lastFiredKey = `fifo_alarm_last_fired`;
      const lastFired = localStorage.getItem(lastFiredKey);
      if (!alarm.fired && sinceAlarm >= 0 && sinceAlarm < 60 * 60_000
          && lastFired !== `${todayKey} ${a.time}` && !alarm.snoozeUntil) {
        localStorage.setItem(lastFiredKey, `${todayKey} ${a.time}`);
        triggerAlarm();
      }
    }

    // If a snooze deadline has passed while hidden, fire immediately
    if (alarm.snoozeUntil && Date.now() >= alarm.snoozeUntil) {
      alarm.snoozeUntil = null;
      triggerAlarm();
    }
  });

  window.addEventListener('pageshow', () => {
    if (alarm.armed) playSilentLoop();
  });

  /* ──────────────────────────────────────────────────────────
     BOOT
     ────────────────────────────────────────────────────────── */
  // Splash → app fade
  const splash = $('splash');
  const appWrap = $('app-wrapper');
  setTimeout(() => {
    splash?.classList.add('fade-out');
    appWrap?.classList.add('visible');
    setTimeout(() => { if (splash) splash.style.display = 'none'; }, 650);
  }, 2300);

  render();

  // Re-render at the next midnight, then daily
  const msToMidnight = () => {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1) - n;
  };
  setTimeout(() => { render(); setInterval(render, 86_400_000); }, msToMidnight());

  // Expose a tiny debug surface (handy in DevTools)
  window.FIFO = { render, loadAlarm, loadRoster, loadReminders, triggerAlarm, stopAlarm };
})();