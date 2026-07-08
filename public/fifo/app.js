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
    voice:      'fifo_voice_notes_v1',
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
  const loadSpotify   = () => {
    const d = readJSON(KEYS.spotify, { url: '', presets: [] });
    if (!Array.isArray(d.presets)) d.presets = [];
    return d;
  };
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
      ? { text: r, color: null, time: null, notified: false }
      : {
          text: (r && r.text) || '',
          color: (r && r.color && REM_COLORS[r.color]) ? r.color : null,
          time: (r && typeof r.time === 'string' && /^\d{2}:\d{2}$/.test(r.time)) ? r.time : null,
          notified: !!(r && r.notified),
        };
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
    updateAlarmBtnState();
  };
  const disableBedtime = () => {
    $('bedtime-overlay')?.classList.remove('active');
    if (!alarm.armed) releaseWakeLock();
    updateAlarmBtnState();
  };

  const updateAlarmBtnState = () => {
    const btn = document.getElementById('alarm-hero-btn');
    if (!btn) return;
    const armed = !!(loadAlarm().on && loadAlarm().time);
    const bedtime = !!$('bedtime-overlay')?.classList.contains('active');
    btn.classList.toggle('armed', armed);
    btn.classList.toggle('bedtime', bedtime);
  };

  const toggleBedtime = () => {
    const on = $('bedtime-overlay')?.classList.contains('active');
    if (on) disableBedtime();
    else {
      enableBedtime();
      requestNotificationPermission();
    }
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
      const n = new Notification('Rotation', {
        body: `Wake up — alarm set for ${fmt12(loadAlarm().time)}`,
        tag: 'fifo-alarm',
        requireInteraction: true,
        silent: false,
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* ignore */ }
  };

  /* ──────────────────────────────────────────────────────────
     REMINDER NOTIFICATIONS (fires when app is opened)
     ────────────────────────────────────────────────────────── */
  const showReminderAlert = (rem, dateStr) => {
    const [y, m, d] = dateStr.split('-');
    const dateLabel = new Date(+y, +m - 1, +d).toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    $('reminder-alert-title').textContent = rem.text || 'Reminder';
    $('reminder-alert-sub').textContent = rem.time
      ? `Scheduled for ${fmt12(rem.time)}`
      : 'Reminder for today';
    $('reminder-alert-time').textContent = dateLabel;
    $('reminder-alert').classList.add('active');
    document.body.style.overflow = 'hidden';
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(rem.text || 'Reminder', {
          body: rem.time ? `${fmt12(rem.time)} — ${dateLabel}` : dateLabel,
          tag: `fifo-rem-${dateStr}-${rem.time || ''}`,
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* ignore */ }
    }
    if ('vibrate' in navigator) {
      try { navigator.vibrate([200, 100, 200]); } catch { /* ignore */ }
    }
  };
  const dismissReminderAlert = () => {
    $('reminder-alert').classList.remove('active');
    if (!$('alarm-alert').classList.contains('active')) {
      document.body.style.overflow = '';
    }
  };
  let reminderAlertQueue = [];
  const drainReminderQueue = () => {
    if ($('reminder-alert').classList.contains('active')) return;
    if ($('alarm-alert').classList.contains('active')) return;
    const next = reminderAlertQueue.shift();
    if (next) showReminderAlert(next.rem, next.dateStr);
  };
  const checkReminderNotifications = () => {
    const now = new Date();
    const todayKey = isoDate(now);
    const rems = loadReminders();
    const list = rems[todayKey];
    if (!list || !list.length) return;
    let changed = false;
    list.forEach((rem) => {
      if (rem.notified) return;
      if (rem.time) {
        const [hh, mm] = rem.time.split(':').map(Number);
        const ts = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm).getTime();
        if (now.getTime() < ts) return;
      }
      rem.notified = true;
      changed = true;
      reminderAlertQueue.push({ rem: { ...rem }, dateStr: todayKey });
    });
    if (changed) {
      saveReminders(rems);
      drainReminderQueue();
    }
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
              <span class="rem-text">${rem.time ? `<strong style="color:#6bb8ff;font-family:var(--mono);margin-right:8px;">${esc(fmt12(rem.time))}</strong>` : ''}${esc(rem.text)}</span>
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
        <div class="rem-add-row" style="margin-top:10px;align-items:center;gap:10px;">
          <label for="reminder-time" style="font-size:13px;color:var(--muted);">Notify at (optional)</label>
          <input type="time" id="reminder-time" style="background:var(--card);color:var(--fg);border:1px solid var(--border,#333);border-radius:10px;padding:8px 10px;font-family:var(--mono);font-size:14px;">
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
    const timeInput = $('reminder-time');
    const timeVal = (timeInput?.value || '').trim();
    const time = /^\d{2}:\d{2}$/.test(timeVal) ? timeVal : null;
    const rems = loadReminders();
    (rems[dateStr] ||= []).push({ text, color: remPickerColor || null, time, notified: false });
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
    updateAlarmBtnState();
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
        <section class="hero-carousel-wrap" aria-label="Dashboard">
          <div class="hero-carousel">
            <article class="hero-card hero premium on-rr">
              <div class="hero-glow" aria-hidden="true"></div>
              <div class="hero-shine" aria-hidden="true"></div>
              <div class="hero-badge on-rr">
                <span class="hero-badge-dot"></span>No Roster Yet
              </div>
              <button class="hero-roster-btn set-roster-btn" data-action="open-roster-sheet" aria-label="Set roster">
                <span>Set Roster</span>
              </button>
              <div class="hero-number-wrap">
                <div class="hero-number" style="--fill:0%">—</div>
                <div class="hero-unit">days remaining</div>
              </div>
              <div class="hero-next glow-amber">
                <div class="hero-next-label">⛏ Tap “Set Roster” to begin</div>
                <div class="hero-next-date">Enter your swing start date &amp; pattern</div>
              </div>
            </article>
          </div>
        </section>
        ${buildCalendar()}`;
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
    const nextGlowClass = isOnSwing ? 'glow-green' : 'glow-amber';

    // --- Card 1: Countdown ---
    const cardCountdown = `
      <article class="hero-card hero premium ${isOnSwing ? '' : 'on-rr'}">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="hero-shine" aria-hidden="true"></div>
        <div class="hero-badge ${isOnSwing ? 'on-site' : 'on-rr'}">
          <span class="hero-badge-dot"></span>${isOnSwing ? 'On Site' : 'On R&R'}
        </div>
        <button class="hero-roster-btn set-roster-btn" data-action="open-roster-sheet" aria-label="Set roster">
          <span>Set Roster</span>
        </button>
        <div class="hero-number-wrap">
          <div class="hero-number ${hc}" style="--fill:${pct}%">${heroNum}</div>
          <div class="hero-unit">${heroNum === 1 ? 'day' : 'days'} remaining</div>
        </div>
        <div class="hero-next ${nextGlowClass}">
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
    const flight = readJSON(KEYS.flight, {});
    const fv = (k, fallback = '') => esc(flight[k] || fallback);
    const flyHomeVal = flight.flyHomeDate || isoDate(flyHomeDate);
    const returnVal  = flight.returnDate  || isoDate(returnDate);

    const cardTravel = `
      <article class="hero-card travel-card premium">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="hero-shine" aria-hidden="true"></div>
        <div class="hero-badge on-site">
          <span class="hero-badge-dot"></span>Flight Details
        </div>
        <div class="hero-card-title">Travel</div>

        <form class="flight-form" data-action="noop" onsubmit="return false;">
          <div class="ff-row two">
            <label class="ff-field">
              <span>Airline</span>
              <input type="text" data-flight="airline" value="${fv('airline')}" placeholder="Qantas">
            </label>
            <label class="ff-field">
              <span>Flight No.</span>
              <input type="text" data-flight="number" value="${fv('number')}" placeholder="QF123" class="mono">
            </label>
          </div>
          <div class="ff-row two">
            <label class="ff-field">
              <span>Check-in</span>
              <input type="time" data-flight="checkin" value="${fv('checkin')}" class="mono">
            </label>
            <label class="ff-field">
              <span>Departure</span>
              <input type="time" data-flight="time" value="${fv('time')}" class="mono">
            </label>
          </div>
          <div class="ff-row two">
            <label class="ff-field">
              <span>Terminal</span>
              <input type="text" data-flight="terminal" value="${fv('terminal')}" placeholder="T2" class="mono">
            </label>
            <label class="ff-field">
              <span>Gate</span>
              <input type="text" data-flight="gate" value="${fv('gate')}" placeholder="G12" class="mono">
            </label>
          </div>
          <div class="ff-row two">
            <label class="ff-field">
              <span>From</span>
              <input type="text" data-flight="from" value="${fv('from')}" placeholder="PER" maxlength="4" class="mono up">
            </label>
            <label class="ff-field">
              <span>To</span>
              <input type="text" data-flight="to" value="${fv('to')}" placeholder="SYD" maxlength="4" class="mono up">
            </label>
          </div>
          <div class="ff-row two">
            <label class="ff-field glow-green">
              <span>Fly Home</span>
              <input type="date" data-flight="flyHomeDate" value="${esc(flyHomeVal)}" class="mono">
            </label>
            <label class="ff-field glow-amber">
              <span>Return to Site</span>
              <input type="date" data-flight="returnDate" value="${esc(returnVal)}" class="mono">
            </label>
          </div>
          <div class="ff-status" id="flight-save-status">Auto-saves</div>
        </form>
      </article>`;

    // --- Card 3: Roster & Shift ---
    const rStart = roster.startDate || isoDate(new Date());
    const rOn    = roster.daysOn ?? 14;
    const rOff   = roster.daysOff ?? 7;
    const rShift = roster.shiftType || 'day';
    const cardRoster = `
      <article class="hero-card travel-card premium roster-card">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="hero-shine" aria-hidden="true"></div>
        <div class="hero-badge on-site">
          <span class="hero-badge-dot"></span>Roster & Shift
        </div>
        <div class="hero-card-title">Roster</div>
        <form class="flight-form" onsubmit="return false;">
          <label class="ff-field">
            <span>Swing Start Date</span>
            <input type="date" data-roster="startDate" value="${esc(rStart)}" class="mono">
          </label>
          <div class="ff-row two">
            <label class="ff-field">
              <span>Days On</span>
              <input type="number" min="1" max="365" data-roster="daysOn" value="${rOn}" class="mono">
            </label>
            <label class="ff-field">
              <span>Days Off</span>
              <input type="number" min="1" max="365" data-roster="daysOff" value="${rOff}" class="mono">
            </label>
          </div>
          <label class="ff-field">
            <span>Current Shift</span>
            <select data-roster="shiftType">
              <option value="day"   ${rShift === 'day'   ? 'selected' : ''}>☀️ Day Shift</option>
              <option value="night" ${rShift === 'night' ? 'selected' : ''}>🌙 Night Shift</option>
            </select>
          </label>
          <div class="ff-status" id="roster-save-status">Changes save when you tap Save</div>
          <button type="button" class="ff-save-btn" data-action="hero-save-roster">
            <span>💾</span><span>Save &amp; Return</span>
          </button>
        </form>
      </article>`;

    // --- Card 3: Notes (single card; Checklist opens as sheet) ---
    const notesText = localStorage.getItem(KEYS.notes) || '';
    const voiceAll  = readJSON(KEYS.voice, []);
    const notesPrev = notesText.trim().slice(0, 180);
    const voiceForNotes = voiceAll.filter(v => v.kind === 'notes').length;
    const cardNotes = `
      <article class="hero-card notes-card premium">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="hero-shine" aria-hidden="true"></div>
        <div class="hero-badge on-site"><span class="hero-badge-dot"></span>Notes</div>
        <button class="hero-roster-btn checklist-btn" data-action="open-checklist-sheet" aria-label="Open checklist">
          <span class="hero-badge-dot" aria-hidden="true"></span>List
        </button>
        <div class="hero-card-title">Notes</div>
        <div class="notes-preview">${
          notesPrev
            ? esc(notesPrev) + (notesText.length > 180 ? '…' : '')
            : '<em>Tap Write or Mic to capture a note</em>'
        }</div>
        <div class="notes-actions">
          <button class="notes-btn write" data-action="notes-write" data-kind="notes">
            <span class="nb-icon">✎</span><span>Write</span>
          </button>
          <button class="notes-btn mic" data-action="notes-mic" data-kind="notes">
            <span class="nb-icon">🎙</span><span>Mic</span>
          </button>
        </div>
        ${voiceForNotes ? `<div class="notes-voice-count">${voiceForNotes} voice note${voiceForNotes === 1 ? '' : 's'}</div>` : ''}
      </article>`;

    const cards = [cardCountdown, cardTravel, cardNotes];
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
      ${buildCalendar()}`;

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
    const restore = window.__heroSlideIdx || 0;
    car.scrollLeft = restore * car.clientWidth;
    window.__heroSlideIdx = 0;
    let raf = null;
    const updateDots = () => {
      const w = car.clientWidth || 1;
      const idx = Math.round(car.scrollLeft / w);
      window.__heroSlideIdx = idx;
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

  /* ──────────────────────────────────────────────────────────
     NOTES CARD (below calendar) — swipe: Notes / Checklist
     ────────────────────────────────────────────────────────── */
  const buildNotesCard = () => {
    const notesText = localStorage.getItem(KEYS.notes) || '';
    const dfText    = localStorage.getItem(KEYS.dontForget) || '';
    const voice     = readJSON(KEYS.voice, []);
    const notesPrev = notesText.trim().slice(0, 140);
    const dfItems   = dfText.split('\n').map(s => s.trim()).filter(Boolean);
    const voiceForNotes    = voice.filter(v => v.kind === 'notes').length;
    const voiceForChecklist= voice.filter(v => v.kind === 'checklist').length;

    const page = (title, kind, preview, count) => `
      <div class="notes-slide" data-idx="${kind === 'notes' ? 0 : 1}">
        <article class="hero-card notes-card premium">
          <div class="hero-glow" aria-hidden="true"></div>
          <div class="hero-shine" aria-hidden="true"></div>
          <div class="hero-badge on-site"><span class="hero-badge-dot"></span>${title}</div>
          <div class="hero-card-title">${title}</div>
          <div class="notes-preview">${preview}</div>
          <div class="notes-actions">
            <button class="notes-btn write" data-action="notes-write" data-kind="${kind}">
              <span class="nb-icon">✎</span><span>Write</span>
            </button>
            <button class="notes-btn mic" data-action="notes-mic" data-kind="${kind}">
              <span class="nb-icon">🎙</span><span>Mic</span>
            </button>
          </div>
          ${count ? `<div class="notes-voice-count">${count} voice note${count === 1 ? '' : 's'}</div>` : ''}
        </article>
      </div>`;

    const notesPage = page(
      'Notes', 'notes',
      notesPrev ? esc(notesPrev) + (notesText.length > 140 ? '…' : '') : '<em>Tap Write or Mic to capture a note</em>',
      voiceForNotes,
    );
    const listPage = page(
      'Checklist', 'checklist',
      dfItems.length
        ? dfItems.slice(0, 4).map(s => `• ${esc(s.replace(/^[•\-\*]\s*/, ''))}`).join('<br>')
          + (dfItems.length > 4 ? `<br><span class="muted">+${dfItems.length - 4} more</span>` : '')
        : '<em>Tap Write or Mic to add checklist items</em>',
      voiceForChecklist,
    );

    return `
      <section class="notes-carousel-wrap" aria-label="Notes">
        <div class="notes-carousel hero-carousel" id="notes-carousel" role="region" aria-roledescription="carousel">
          ${notesPage}${listPage}
        </div>
        <div class="hero-dots" id="notes-dots" role="tablist">
          <button class="hero-dot active" data-action="notes-dot" data-idx="0" aria-label="Notes"></button>
          <button class="hero-dot" data-action="notes-dot" data-idx="1" aria-label="Checklist"></button>
        </div>
      </section>`;
  };

  const setupNotesCarousel = () => {
    const car = $('notes-carousel');
    const dots = $('notes-dots');
    if (!car || !dots) return;
    car.scrollLeft = 0;
    let raf = null;
    car.addEventListener('scroll', () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const w = car.clientWidth || 1;
        const idx = Math.round(car.scrollLeft / w);
        dots.querySelectorAll('.hero-dot').forEach((d, i) => d.classList.toggle('active', i === idx));
      });
    }, { passive: true });
  };
  const goNotesSlide = (idx) => {
    const car = $('notes-carousel');
    if (!car) return;
    car.scrollTo({ left: car.clientWidth * idx, behavior: 'smooth' });
  };

  /* ── Auto-save handlers for Travel & Roster inline forms */
  const saveFlightField = (key, value) => {
    const cur = readJSON(KEYS.flight, {});
    if (key === 'from' || key === 'to') value = (value || '').toUpperCase();
    cur[key] = value;
    writeJSON(KEYS.flight, cur);
    const s = $('flight-save-status');
    if (s) { s.textContent = '✓ Saved'; s.classList.add('ok'); clearTimeout(saveFlightField._t);
      saveFlightField._t = setTimeout(() => { s.textContent = 'Auto-saves'; s.classList.remove('ok'); }, 1400); }
  };
  const saveRosterField = (key, value) => {
    const cur = loadRoster() || {};
    if (key === 'daysOn' || key === 'daysOff') value = Math.max(1, parseInt(value, 10) || 1);
    cur[key] = value;
    saveRoster(cur);
    const s = $('roster-save-status');
    if (s) { s.textContent = '● Unsaved changes'; s.classList.remove('ok'); s.classList.add('dirty'); }
  };
  const heroSaveRoster = () => {
    const s = $('roster-save-status');
    if (s) { s.textContent = '✓ Saved'; s.classList.add('ok'); s.classList.remove('dirty'); }
    closeRosterSheet();
  };

  /* ── Roster Sheet (opened from Hero 📅 button) */
  const openRosterSheet = () => {
    const roster = loadRoster() || {};
    const rStart = roster.startDate || isoDate(new Date());
    const rOn    = roster.daysOn ?? 14;
    const rOff   = roster.daysOff ?? 7;
    const rShift = roster.shiftType || 'day';
    document.body.insertAdjacentHTML('beforeend', `
      <div class="roster-sheet" id="roster-sheet">
        <div class="rs-backdrop" data-action="close-roster-sheet"></div>
        <div class="rs-card hero-card travel-card premium roster-card" role="dialog" aria-modal="true" aria-label="Edit roster">
          <div class="hero-glow" aria-hidden="true"></div>
          <div class="hero-shine" aria-hidden="true"></div>
          <button class="rs-close" data-action="close-roster-sheet" aria-label="Close">✕</button>
          <div class="hero-badge on-site"><span class="hero-badge-dot"></span>Roster &amp; Shift</div>
          <div class="hero-card-title">Roster</div>
          <form class="flight-form" onsubmit="return false;">
            <label class="ff-field">
              <span>Swing Start Date</span>
              <input type="date" data-roster="startDate" value="${esc(rStart)}" class="mono">
            </label>
            <div class="ff-row two">
              <label class="ff-field">
                <span>Days On</span>
                <input type="number" min="1" max="365" data-roster="daysOn" value="${rOn}" class="mono">
              </label>
              <label class="ff-field">
                <span>Days Off</span>
                <input type="number" min="1" max="365" data-roster="daysOff" value="${rOff}" class="mono">
              </label>
            </div>
            <label class="ff-field">
              <span>Current Shift</span>
              <select data-roster="shiftType">
                <option value="day"   ${rShift === 'day'   ? 'selected' : ''}>☀️ Day Shift</option>
                <option value="night" ${rShift === 'night' ? 'selected' : ''}>🌙 Night Shift</option>
              </select>
            </label>
            <div class="ff-status" id="roster-save-status">Changes save when you tap Save</div>
            <button type="button" class="ff-save-btn" data-action="hero-save-roster">
              <span>💾</span><span>Save &amp; Return</span>
            </button>
          </form>
        </div>
      </div>`);
    document.body.style.overflow = 'hidden';
  };
  const closeRosterSheet = () => {
    $('roster-sheet')?.remove();
    document.body.style.overflow = '';
    render();
  };

  /* ── Checklist Sheet (opened from Notes card ✓ button) */
  const parseListItems = () => {
    const raw = localStorage.getItem(KEYS.dontForget) || '';
    return raw.split('\n').map(line => {
      const s = line.trim();
      if (!s) return null;
      if (/^\[x\]\s*/i.test(s)) return { done: true,  text: s.replace(/^\[x\]\s*/i, '') };
      if (/^\[ \]\s*/  .test(s)) return { done: false, text: s.replace(/^\[ \]\s*/, '') };
      return { done: false, text: s.replace(/^[•\-\*]\s*/, '') };
    }).filter(Boolean);
  };
  const serializeListItems = (items) =>
    items.map(it => `${it.done ? '[x]' : '[ ]'} ${it.text}`).join('\n');
  const saveListItems = (items) =>
    localStorage.setItem(KEYS.dontForget, serializeListItems(items));

  let listState = null;
  const listRowHTML = (it, i) => `
    <div class="list-row${it.done ? ' done' : ''}" data-idx="${i}">
      <button class="list-tick" data-action="list-toggle" data-idx="${i}" aria-label="Toggle done" aria-pressed="${it.done ? 'true' : 'false'}">
        <span class="list-tick-check" aria-hidden="true">✓</span>
      </button>
      <input class="list-input" data-idx="${i}" type="text" value="${esc(it.text)}" placeholder="List item" autocomplete="off" autocapitalize="sentences" />
      <button class="list-del" data-action="list-remove" data-idx="${i}" aria-label="Remove item" tabindex="-1">×</button>
    </div>`;
  const listNewRowHTML = (i) => `
    <div class="list-row new-row" data-idx="${i}">
      <span class="list-tick placeholder" aria-hidden="true"><span class="list-tick-plus">＋</span></span>
      <input class="list-input" data-idx="${i}" data-new="1" type="text" value="" placeholder="Add item…" autocomplete="off" autocapitalize="sentences" />
    </div>`;
  const renderListItems = () => {
    const wrap = $('list-items');
    if (!wrap || !listState) return;
    const its = listState.items;
    wrap.innerHTML =
      its.map((it, i) => listRowHTML(it, i)).join('') +
      listNewRowHTML(its.length);
  };
  const focusListItem = (idx, atEnd = true) => {
    const inp = document.querySelector(`.list-input[data-idx="${idx}"]`);
    if (!inp) return;
    inp.focus();
    if (atEnd) { try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {} }
  };

  const openChecklistSheet = () => {
    listState = { items: parseListItems() };
    document.body.insertAdjacentHTML('beforeend', `
      <div class="roster-sheet list-sheet" id="checklist-sheet">
        <div class="rs-backdrop" data-action="close-checklist-sheet"></div>
        <div class="rs-card hero-card notes-card premium list-card" role="dialog" aria-modal="true" aria-label="List">
          <div class="hero-glow" aria-hidden="true"></div>
          <div class="hero-shine" aria-hidden="true"></div>
          <div class="rs-swipe-handle" aria-hidden="true"><span></span></div>
          <button class="rs-back" data-action="close-checklist-sheet" aria-label="Back">
            <span class="rs-back-chev" aria-hidden="true">‹</span><span>Back</span>
          </button>
          <div class="hero-badge on-site"><span class="hero-badge-dot"></span>List</div>
          <div class="hero-card-title">List</div>
          <div class="list-items" id="list-items"></div>
          <div class="list-actions">
            <button class="notes-btn mic" data-action="notes-mic" data-kind="checklist">
              <span class="nb-icon">🎙</span><span>Voice add</span>
            </button>
          </div>
        </div>
      </div>`);
    renderListItems();
    const card = document.querySelector('#checklist-sheet .rs-card');
    if (card) attachSwipeDown(card, closeChecklistSheet);
    document.body.style.overflow = 'hidden';
  };
  const closeChecklistSheet = () => {
    $('checklist-sheet')?.remove();
    listState = null;
    document.body.style.overflow = '';
    render();
  };

  /* ──────────────────────────────────────────────────────────
     NOTES EDITOR (full-screen) + MIC (speech-to-text or recorder)
     ────────────────────────────────────────────────────────── */
  const NOTE_META = {
    notes:     { key: KEYS.notes,      title: 'Notes' },
    checklist: { key: KEYS.dontForget, title: 'Checklist' },
  };

  let editorState = null;
  const openNoteEditor = (kind) => {
    const meta = NOTE_META[kind]; if (!meta) return;
    const val = localStorage.getItem(meta.key) || '';
    const ph = kind === 'checklist'
      ? '• Flight check-in\n• Charger\n• Boots\n• Medications'
      : 'Write anything…';
    document.body.insertAdjacentHTML('beforeend', `
      <div class="note-editor" id="note-editor">
        <div class="ne-head">
          <button class="ne-back" data-action="close-editor">← Back</button>
          <div class="ne-title">${meta.title}</div>
          <div class="ne-status" id="ne-status">Auto-saves</div>
        </div>
        <textarea class="ne-ta" id="ne-ta" placeholder="${ph}"></textarea>
      </div>`);
    const ta = $('ne-ta');
    ta.value = val;
    setTimeout(() => { ta.focus(); }, 50);
    editorState = { kind };
    let t = null;
    ta.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        localStorage.setItem(meta.key, ta.value);
        const s = $('ne-status');
        if (s) { s.textContent = '✓ Saved'; setTimeout(() => s.textContent = 'Auto-saves', 1200); }
      }, 400);
    });
  };
  const closeNoteEditor = () => {
    $('note-editor')?.remove();
    editorState = null;
    render();
  };

  /* Mic — prefer Web Speech Recognition; fallback to MediaRecorder */
  let recState = null;
  const openMicOverlay = (kind) => {
    const meta = NOTE_META[kind]; if (!meta) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="mic-overlay" id="mic-overlay">
        <div class="mic-card">
          <div class="mic-title">${meta.title} — Voice</div>
          <div class="mic-dot" id="mic-dot"></div>
          <div class="mic-status" id="mic-status">Preparing…</div>
          <div class="mic-transcript" id="mic-transcript"></div>
          <div class="mic-btns">
            <button class="mic-cancel" data-action="mic-cancel">Cancel</button>
            <button class="mic-stop" data-action="mic-stop">Stop &amp; Save</button>
          </div>
        </div>
      </div>`);
    startMic(kind);
  };

  const startMic = async (kind) => {
    const status = $('mic-status');
    const tEl = $('mic-transcript');
    const dot = $('mic-dot');
    const meta = NOTE_META[kind];
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (SR) {
      try {
        const rec = new SR();
        rec.lang = 'en-AU';
        rec.continuous = true;
        rec.interimResults = true;
        let finalText = '';
        rec.onresult = (e) => {
          let interim = '';
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) finalText += r[0].transcript + ' ';
            else interim += r[0].transcript;
          }
          tEl.textContent = (finalText + interim).trim();
        };
        rec.onerror = () => { status.textContent = 'Speech error — try again'; };
        rec.onend = () => { dot?.classList.remove('active'); };
        rec.start();
        dot?.classList.add('active');
        status.textContent = '🎙 Listening… speak now';
        recState = { kind, kind_: 'sr', rec, getText: () => tEl.textContent.trim() };
        return;
      } catch { /* fall through */ }
    }
    // Fallback: record audio blob and store as data URL
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks = [];
      mr.ondataavailable = (e) => chunks.push(e.data);
      mr.start();
      dot?.classList.add('active');
      status.textContent = '🎙 Recording… (speech-to-text unavailable)';
      tEl.textContent = '(Audio will be saved locally)';
      recState = { kind, kind_: 'rec', mr, stream, chunks, meta };
    } catch (err) {
      status.textContent = 'Microphone unavailable';
    }
  };

  const stopMicSave = async () => {
    if (!recState) return closeMicOverlay();
    const kind = recState.kind;
    const meta = NOTE_META[kind];
    if (recState.kind_ === 'sr') {
      try { recState.rec.stop(); } catch {}
      const text = recState.getText();
      if (text) {
        const existing = localStorage.getItem(meta.key) || '';
        const stamp = new Date().toLocaleString('en-AU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' });
        const line = kind === 'checklist'
          ? text.split(/[,;]|\band\b/i).map(s => s.trim()).filter(Boolean).map(s => `• ${s}`).join('\n')
          : `[${stamp}] ${text}`;
        localStorage.setItem(meta.key, existing ? `${existing}\n${line}` : line);
      }
    } else if (recState.kind_ === 'rec') {
      const { mr, stream, chunks } = recState;
      await new Promise((res) => { mr.onstop = res; try { mr.stop(); } catch { res(); } });
      stream.getTracks().forEach(t => t.stop());
      if (chunks.length) {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        const dataUrl = await new Promise((res) => {
          const r = new FileReader(); r.onloadend = () => res(r.result); r.readAsDataURL(blob);
        });
        const list = readJSON(KEYS.voice, []);
        list.push({ kind, at: Date.now(), audio: dataUrl });
        writeJSON(KEYS.voice, list);
      }
    }
    closeMicOverlay();
  };

  const closeMicOverlay = () => {
    if (recState) {
      try { recState.rec?.stop(); } catch {}
      try { recState.mr?.stop(); } catch {}
      recState.stream?.getTracks().forEach(t => t.stop());
    }
    recState = null;
    $('mic-overlay')?.remove();
    render();
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
      <button class="sub-back-btn" data-action="close-panel">Close</button>
      ${menuBtn('📅', 'Roster & Shift', 'Set your swing pattern', 'open-roster')}
      ${menuBtn('⏰', 'Alarm', alarmSub, 'open-alarm')}`;
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
    const presets = ['04:00','04:30','05:00','05:30','06:00','06:30'];
    const curTime = a.time || '06:00';
    const presetPill = (t) => curTime === t ? 'active' : '';
    const notifState = ('Notification' in window) ? Notification.permission : 'unsupported';
    const notifOn = notifState === 'granted';
    const notifCls = notifState === 'unsupported' ? 'off' : (notifOn ? 'on' : 'off');
    const notifLabel = notifState === 'unsupported' ? 'Notifications unavailable'
                     : notifOn ? 'Notifications ON' : 'Notifications OFF';

    $('settings-panel').innerHTML = `
      <div class="panel-handle"></div>
      <div class="panel-title alarm-title-premium">Wake-up Alarm</div>
      <button class="sub-back-btn" data-action="back-to-menu">Back to Settings</button>
      <div class="panel-row alarm-toggle-row">
        <label class="toggle toggle-lg ${a.on ? 'is-on' : 'is-off'}" id="alarm-toggle-wrap">
          <input type="checkbox" id="alarm-toggle" ${a.on ? 'checked' : ''} data-action="toggle-alarm">
          <div class="toggle-track"></div>
          <div class="toggle-thumb"></div>
          <span class="toggle-status-lg ${a.on ? 'on' : 'off'}" id="alarm-toggle-label">${a.on ? 'ON' : 'OFF'}</span>
        </label>
      </div>
      <div class="form-group">
        <label class="label-center" for="alarm-time-input">Wake-up Time</label>
        <input type="time" class="time-input time-input-premium" id="alarm-time-input" value="${a.time || '06:00'}" data-action="alarm-time-change">
      </div>
      <div class="form-group">
        <label class="label-center">Quick Presets</label>
        <div class="preset-grid">
          ${presets.map(t => `<button type="button" class="preset-pill ${presetPill(t)}" data-action="preset-pick" data-time="${t}">${fmt12(t)}</button>`).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="label-center">Snooze Duration</label>
        <div class="preset-grid snooze-grid">
          ${[3,5,10,15,20,30].map(m => `<button type="button" class="preset-pill snooze-pill ${pill(m)}" data-action="snooze-pick" data-min="${m}">${m} min</button>`).join('')}
        </div>
      </div>
      <div id="alarm-sub-msg" class="panel-msg"></div>
      <div class="form-group">
        <button type="button" class="notif-btn ${notifCls}" id="notif-btn" data-action="toggle-notification" ${notifState==='unsupported'?'disabled':''}>
          <span class="notif-dot"></span><span id="notif-label">🔔 ${notifLabel}</span>
        </button>
      </div>`;

    // Auto-enable alarm sound engine whenever the alarm sheet opens
    resumeCtx().then(startKeepAlive);
    playSilentLoop();
    const timeInp = $('alarm-time-input');
    if (timeInp) {
      timeInp.addEventListener('change', () => {
        const t = timeInp.value; if (!t) return;
        const a2 = loadAlarm(); a2.time = t; a2.on = true; saveAlarm(a2);
        // clear any preset active state (manual)
        document.querySelectorAll('.preset-pill[data-action="preset-pick"]').forEach(p => {
          p.classList.toggle('active', p.dataset.time === t);
        });
        setAlarmToggleUI(true);
        renderAlarmStatus();
        flashAlarmMsg(`✓ Alarm set for ${fmt12(t)}`);
      });
    }
  };

  const setAlarmToggleUI = (on) => {
    const wrap = $('alarm-toggle-wrap');
    const tog  = $('alarm-toggle');
    const lbl  = $('alarm-toggle-label');
    if (tog) tog.checked = on;
    if (wrap) { wrap.classList.toggle('is-on', on); wrap.classList.toggle('is-off', !on); }
    if (lbl) { lbl.textContent = on ? 'ON' : 'OFF'; lbl.className = `toggle-status-lg ${on ? 'on' : 'off'}`; }
  };
  const flashAlarmMsg = (txt) => {
    const msg = $('alarm-sub-msg');
    if (msg) { msg.textContent = txt; setTimeout(() => { msg.textContent = ''; }, 1800); }
  };

  const toggleAlarmCheckbox = (on) => {
    const a = loadAlarm(); a.on = on; saveAlarm(a);
    setAlarmToggleUI(on);
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
    document.querySelectorAll('.preset-pill[data-action="snooze-pick"]').forEach((p) => {
      p.classList.toggle('active', parseInt(p.dataset.min, 10) === mins);
    });
    const a = loadAlarm(); a.snooze = mins; saveAlarm(a);
    flashAlarmMsg(`✓ Snooze set to ${mins} min`);
  };

  const selectPresetTime = (time) => {
    if (!time) return;
    document.querySelectorAll('.preset-pill[data-action="preset-pick"]').forEach((p) => {
      p.classList.toggle('active', p.dataset.time === time);
    });
    const inp = $('alarm-time-input'); if (inp) inp.value = time;
    const a = loadAlarm();
    a.time = time; a.on = true;
    saveAlarm(a);
    alarm.fired = false; alarm.snoozeUntil = null;
    if (alarm.snoozeTimer) { clearTimeout(alarm.snoozeTimer); alarm.snoozeTimer = null; }
    resumeCtx().then(startKeepAlive);
    playSilentLoop();
    setAlarmToggleUI(true);
    renderAlarmStatus();
    flashAlarmMsg(`✓ Alarm set for ${fmt12(time)}`);
  };

  const applyNotifButtonState = () => {
    const btn = $('notif-btn'); const lbl = $('notif-label');
    if (!btn) return;
    const state = ('Notification' in window) ? Notification.permission : 'unsupported';
    btn.classList.remove('on','off');
    if (state === 'granted') { btn.classList.add('on'); if (lbl) lbl.textContent = '🔔 Notifications ON'; }
    else if (state === 'unsupported') { btn.classList.add('off'); btn.disabled = true; if (lbl) lbl.textContent = '🔔 Notifications unavailable'; }
    else { btn.classList.add('off'); if (lbl) lbl.textContent = '🔔 Notifications OFF'; }
  };

  const toggleNotification = () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') {
      // Can't programmatically revoke; guide user
      const msg = $('alarm-sub-msg');
      if (msg) { msg.textContent = 'Disable notifications in browser settings'; setTimeout(() => { msg.textContent = ''; }, 2400); }
      return;
    }
    Notification.requestPermission().then(applyNotifButtonState).catch(() => {});
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

  /* ── Music (Spotify) premium sheet ── */
  const renderMusicPresetList = () => {
    const sp = loadSpotify();
    const active = (sp.url || '').trim();
    const wrap = $('music-preset-list');
    if (!wrap) return;
    if (!sp.presets.length) {
      wrap.innerHTML = `<div class="music-empty">No saved playlists yet — add one below.</div>`;
      return;
    }
    wrap.innerHTML = sp.presets.map((p, i) => {
      const isActive = p.url === active;
      return `
        <div class="music-card ${isActive ? 'active' : ''}" data-action="music-activate" data-i="${i}">
          <div class="music-card-bar"></div>
          <div class="music-card-body">
            <div class="music-card-name">${esc(p.name || 'Untitled')}</div>
            <div class="music-card-url">${esc(p.url)}</div>
          </div>
          ${isActive ? '<div class="music-card-badge">ACTIVE</div>' : ''}
          <button type="button" class="music-card-del" data-action="music-delete" data-i="${i}" aria-label="Delete">✕</button>
        </div>`;
    }).join('');
  };

  const openSubSpotify = () => {
    const sp = loadSpotify();
    $('settings-panel').innerHTML = `
      <div class="panel-handle"></div>
      <div class="panel-title alarm-title-premium">Music</div>
      <div class="form-group">
        <label class="label-center">Saved Playlists</label>
        <div id="music-preset-list" class="music-preset-list"></div>
      </div>
      <div class="form-group">
        <label class="label-center">Quick Add</label>
        <div class="music-slot-grid">
          <div class="music-slot">
            <input type="text" class="music-slot-name" data-slot="0" placeholder="Name">
            <input type="url"  class="music-slot-url"  data-slot="0" placeholder="Paste Spotify link">
            <button type="button" class="music-slot-save" data-action="music-slot-save" data-slot="0" aria-label="Save">✓</button>
          </div>
        </div>
      </div>
      <div class="spotify-status panel-msg" id="spotify-status"></div>`;
    renderMusicPresetList();
  };

  const testSpotifyLink = () => {
    const url = ($('spotify-url-input')?.value || '').trim();
    if (url) { const sp = loadSpotify(); sp.url = url; saveSpotify(sp); }
    doOpenSpotify('spotify-status');
  };
  const musicUrlChange = () => {
    const url = ($('spotify-url-input')?.value || '').trim();
    const sp = loadSpotify(); sp.url = url; saveSpotify(sp);
    renderMusicPresetList();
    flashMusicMsg(url ? '✓ Active link updated' : 'Cleared');
  };
  const musicAdd = () => {};
  const musicSlotSave = (t) => {
    const slot = t.dataset.slot;
    const panel = $('settings-panel');
    const nameEl = panel?.querySelector(`.music-slot-name[data-slot="${slot}"]`);
    const urlEl  = panel?.querySelector(`.music-slot-url[data-slot="${slot}"]`);
    const name = (nameEl?.value || '').trim();
    const url  = (urlEl?.value  || '').trim();
    if (!url) return flashMusicMsg('Paste a link first', true);
    const sp = loadSpotify();
    sp.presets.push({ name: name || 'Playlist', url });
    sp.url = url;
    saveSpotify(sp);
    if (nameEl) nameEl.value = '';
    if (urlEl)  urlEl.value  = '';
    renderMusicPresetList();
    flashMusicMsg('✓ Playlist saved');
  };
  const musicActivate = (t) => {
    const i = parseInt(t.dataset.i, 10);
    const sp = loadSpotify();
    const p = sp.presets[i]; if (!p) return;
    sp.url = p.url; saveSpotify(sp);
    if ($('spotify-url-input')) $('spotify-url-input').value = p.url;
    renderMusicPresetList();
    flashMusicMsg(`✓ ${p.name} is active`);
  };
  const musicDelete = (t, ev) => {
    ev?.stopPropagation?.();
    const i = parseInt(t.dataset.i, 10);
    const sp = loadSpotify();
    sp.presets.splice(i, 1);
    saveSpotify(sp);
    renderMusicPresetList();
  };
  const flashMusicMsg = (txt, err) => {
    const s = $('spotify-status');
    if (!s) return;
    s.textContent = txt;
    s.className = `spotify-status panel-msg${err ? ' err' : ''}`;
    setTimeout(() => { s.textContent = ''; }, 1800);
  };
  // Legacy alias — no longer wired but kept safe
  const saveSpotifySub = musicUrlChange;

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

  /* ── Flight details quick-edit (used by Travel card) */
  const editFlightDetails = () => {
    const cur = readJSON(KEYS.flight, { number: '', time: '', from: '', to: '', terminal: '', airline: '' });
    const ask = (label, val) => {
      const r = prompt(label, val || '');
      return r === null ? null : r.trim();
    };
    const airline = ask('Airline (e.g. Qantas)', cur.airline);           if (airline === null) return;
    const number  = ask('Flight number (e.g. QF123)', cur.number);       if (number === null)  return;
    const time    = ask('Departure time (e.g. 06:30)', cur.time);        if (time === null)    return;
    const from    = ask('From airport code (e.g. PER)', cur.from);       if (from === null)    return;
    const to      = ask('To airport code (e.g. SYD)', cur.to);           if (to === null)      return;
    const terminal= ask('Terminal (e.g. T2)', cur.terminal);             if (terminal === null)return;
    writeJSON(KEYS.flight, {
      airline, number, time,
      from: from.toUpperCase(), to: to.toUpperCase(),
      terminal,
    });
    render();
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
    'dismiss-reminder': () => { dismissReminderAlert(); drainReminderQueue(); },

    // Settings menu
    'open-roster':      openSubRoster,
    'open-alarm':       openSubAlarm,
    'open-spotify-sub': openSubSpotify,
    'open-dont-forget': openSubDontForget,
    'open-notes':       openSubNotes,
    'open-backup':      openSubBackup,
    'toggle-bedtime':   toggleBedtime,

    // Hero carousel
    'hero-dot': (t) => goHeroSlide(parseInt(t.dataset.idx, 10)),
    'open-alarm-from-hero': () => { openPanel(); openSubAlarm(); },
    'edit-flight':          editFlightDetails,
    'hero-save-roster':     heroSaveRoster,
    'open-roster-sheet':    openRosterSheet,
    'close-roster-sheet':   closeRosterSheet,
    'open-checklist-sheet': openChecklistSheet,
    'close-checklist-sheet': closeChecklistSheet,

    // List (checklist) row actions
    'list-toggle': (t) => {
      if (!listState) return;
      const idx = parseInt(t.dataset.idx, 10);
      if (!listState.items[idx]) return;
      listState.items[idx].done = !listState.items[idx].done;
      saveListItems(listState.items);
      renderListItems();
    },
    'list-remove': (t) => {
      if (!listState) return;
      const idx = parseInt(t.dataset.idx, 10);
      if (isNaN(idx) || !listState.items[idx]) return;
      listState.items.splice(idx, 1);
      saveListItems(listState.items);
      renderListItems();
      focusListItem(Math.max(0, idx - 1));
    },

    // Notes card
    'notes-dot':   (t) => goNotesSlide(parseInt(t.dataset.idx, 10)),
    'notes-write': (t) => openNoteEditor(t.dataset.kind),
    'notes-mic':   (t) => openMicOverlay(t.dataset.kind),
    'close-editor': closeNoteEditor,
    'mic-stop':    stopMicSave,
    'mic-cancel':  closeMicOverlay,

    // Roster
    'save-roster':  saveRosterSub,
    'clear-roster': clearRosterSub,
    'step': (t) => step(t.dataset.target, parseInt(t.dataset.delta, 10)),

    // Alarm subpage
    'snooze-pick':  (t) => selectSnoozePill(parseInt(t.dataset.min, 10)),
    'preset-pick':  (t) => selectPresetTime(t.dataset.time),
    'toggle-notification': toggleNotification,

    // Spotify
    'test-spotify': testSpotifyLink,
    'save-spotify': saveSpotifySub,
    'music-add':      musicAdd,
    'music-slot-save': musicSlotSave,
    'music-activate': musicActivate,
    'music-delete':   musicDelete,

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
    // Suppress synthetic click after a long-press on Music button
    if (target.classList?.contains('music-btn') && window.__musicLongPressed) {
      window.__musicLongPressed = false;
      ev.preventDefault();
      return;
    }
    // Suppress synthetic click after a long-press on Alarm button
    if (target.classList?.contains('alarm-btn') && window.__alarmLongPressed) {
      window.__alarmLongPressed = false;
      ev.preventDefault();
      return;
    }
    actions[target.dataset.action]?.(target, ev);
  });

  // Long-press on Music button → open Music sheet (edit links)
  (() => {
    let timer = null, startX = 0, startY = 0, moved = false;
    const start = (ev) => {
      const btn = ev.target.closest?.('.music-btn');
      if (!btn) return;
      moved = false;
      startX = ev.clientX || ev.touches?.[0]?.clientX || 0;
      startY = ev.clientY || ev.touches?.[0]?.clientY || 0;
      clearTimeout(timer);
      timer = setTimeout(() => {
        window.__musicLongPressed = true;
        btn.classList.add('longpress-flash');
        setTimeout(() => btn.classList.remove('longpress-flash'), 300);
        openPanel(); openSubSpotify();
      }, 500);
    };
    const move = (ev) => {
      if (!timer) return;
      const x = ev.clientX || ev.touches?.[0]?.clientX || 0;
      const y = ev.clientY || ev.touches?.[0]?.clientY || 0;
      if (Math.abs(x - startX) > 10 || Math.abs(y - startY) > 10) {
        moved = true; clearTimeout(timer); timer = null;
      }
    };
    const end = () => { clearTimeout(timer); timer = null; };
    document.addEventListener('pointerdown', start, { passive: true });
    document.addEventListener('pointermove', move,  { passive: true });
    document.addEventListener('pointerup', end,     { passive: true });
    document.addEventListener('pointercancel', end, { passive: true });
  })();

  // Long-press on Alarm button → open Alarm settings sheet
  (() => {
    let timer = null, startX = 0, startY = 0;
    const start = (ev) => {
      const btn = ev.target.closest?.('.alarm-btn');
      if (!btn) return;
      startX = ev.clientX || ev.touches?.[0]?.clientX || 0;
      startY = ev.clientY || ev.touches?.[0]?.clientY || 0;
      clearTimeout(timer);
      timer = setTimeout(() => {
        window.__alarmLongPressed = true;
        btn.classList.add('longpress-flash');
        setTimeout(() => btn.classList.remove('longpress-flash'), 300);
        openPanel(); openSubAlarm();
      }, 500);
    };
    const move = (ev) => {
      if (!timer) return;
      const x = ev.clientX || ev.touches?.[0]?.clientX || 0;
      const y = ev.clientY || ev.touches?.[0]?.clientY || 0;
      if (Math.abs(x - startX) > 10 || Math.abs(y - startY) > 10) {
        clearTimeout(timer); timer = null;
      }
    };
    const end = () => { clearTimeout(timer); timer = null; };
    document.addEventListener('pointerdown', start, { passive: true });
    document.addEventListener('pointermove', move,  { passive: true });
    document.addEventListener('pointerup', end,     { passive: true });
    document.addEventListener('pointercancel', end, { passive: true });
  })();

  // Overlay click-to-close
  document.addEventListener('click', (ev) => {
    if (ev.target.id === 'overlay') closePanel();
  });

  // ── List (Checklist) sheet: input + keyboard behaviour
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!t.classList || !t.classList.contains('list-input') || !listState) return;
    if (t.dataset.new === '1') {
      const val = t.value;
      if (!val) return;
      // Promote the "new" row into a real item and re-render
      listState.items.push({ text: val, done: false });
      saveListItems(listState.items);
      renderListItems();
      focusListItem(listState.items.length - 1);
      return;
    }
    const idx = parseInt(t.dataset.idx, 10);
    if (!listState.items[idx]) return;
    listState.items[idx].text = t.value;
    saveListItems(listState.items);
  });

  document.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (!t.classList || !t.classList.contains('list-input') || !listState) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const isNew = t.dataset.new === '1';
      if (isNew) {
        // If user hit Enter on an empty new row, just close keyboard
        if (!t.value) { t.blur(); return; }
        // Value already promoted via input handler; append a fresh empty item
        listState.items.push({ text: '', done: false });
        saveListItems(listState.items);
        renderListItems();
        focusListItem(listState.items.length - 1);
        return;
      }
      const idx = parseInt(t.dataset.idx, 10);
      listState.items.splice(idx + 1, 0, { text: '', done: false });
      saveListItems(listState.items);
      renderListItems();
      focusListItem(idx + 1);
    } else if (ev.key === 'Backspace' && !t.value) {
      const isNew = t.dataset.new === '1';
      if (isNew) return;
      const idx = parseInt(t.dataset.idx, 10);
      if (!listState.items[idx]) return;
      ev.preventDefault();
      listState.items.splice(idx, 1);
      saveListItems(listState.items);
      renderListItems();
      focusListItem(Math.max(0, idx - 1));
    }
  });

  // ── Swipe-down-to-close for bottom sheets
  function attachSwipeDown(card, onClose) {
    let startY = 0, curY = 0, dragging = false, allowed = false;
    const onStart = (e) => {
      const touch = e.touches ? e.touches[0] : e;
      // Only start a drag if the gesture originates on the handle,
      // the card's own padding, or the title area — never on an input/textarea/button.
      const tgt = e.target;
      const onHandle = !!tgt.closest?.('.rs-swipe-handle, .panel-handle');
      const onControl = !!tgt.closest?.('input, textarea, select, button, .list-row');
      allowed = onHandle || !onControl;
      if (!allowed) return;
      startY = touch.clientY;
      curY = startY;
      dragging = true;
      card.style.transition = 'none';
    };
    const onMove = (e) => {
      if (!dragging) return;
      const touch = e.touches ? e.touches[0] : e;
      curY = touch.clientY;
      const dy = Math.max(0, curY - startY);
      if (dy > 0) card.style.transform = `translateY(${dy}px)`;
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      card.style.transition = '';
      const dy = curY - startY;
      if (dy > 90) {
        card.style.transform = `translateY(100%)`;
        setTimeout(onClose, 180);
      } else {
        card.style.transform = '';
      }
    };
    card.addEventListener('touchstart', onStart, { passive: true });
    card.addEventListener('touchmove',  onMove,  { passive: true });
    card.addEventListener('touchend',   onEnd);
    card.addEventListener('touchcancel', onEnd);
  }
  // Expose for other openers
  window.__attachSwipeDown = attachSwipeDown;

  // Attach swipe-down to the settings overlay panel (uses .panel-handle)
  (() => {
    const panel = document.getElementById('settings-panel');
    if (panel) attachSwipeDown(panel, closePanel);
  })();

  // Toggle / change events
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'alarm-toggle')        toggleAlarmCheckbox(t.checked);
    if (t.id === 'import-file-input')   importBackup(ev);
    if (t.id === 'spotify-url-input')   musicUrlChange();
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
    if (t.dataset?.flight) saveFlightField(t.dataset.flight, t.value);
    if (t.dataset?.roster) saveRosterField(t.dataset.roster, t.value);
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset?.roster) saveRosterField(t.dataset.roster, t.value);
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

  // Reminder notification checks
  requestNotificationPermission();
  checkReminderNotifications();
  setInterval(checkReminderNotifications, 60_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkReminderNotifications();
  });

  // Expose a tiny debug surface (handy in DevTools)
  window.FIFO = { render, loadAlarm, loadRoster, loadReminders, triggerAlarm, stopAlarm };
})();