'use strict';

/* Suricate — app patient.
   - Connexion par pseudo ; le patient peut suivre plusieurs scénarios
     (ex. douleur + sommeil), chacun avec sa métrique et sa précision décimale.
   - Saisie sur une jauge : on déplace le curseur, la valeur s'affiche en grand,
     un gros bouton « Validation » enchaîne les métriques.
   - Hors-ligne : file d'attente locale, envoi idempotent au retour du réseau. */

const API = '';
const LS_PATIENT = 'suricate.patient';   // { id, pseudo, scenarios:[...] }
const LS_QUEUE = 'suricate.queue';

const screens = {
  connect: document.getElementById('screen-connect'),
  gauge: document.getElementById('screen-gauge'),
  done: document.getElementById('screen-done'),
  chart: document.getElementById('screen-chart'),
  help: document.getElementById('screen-help'),
};
const netStatus = document.getElementById('netStatus');
const slider = document.getElementById('gaugeSlider');

let patient = null;       // { id, pseudo }
let scenarios = [];       // [{ metric, precision, name }]
let steps = [];           // séquence de métriques à saisir
let currentStep = 0;
let sessionTime = null;   // horodatage commun à une session de saisie
let collected = [];       // mesures saisies durant la session
let chartReturn = 'done'; // écran de retour depuis « Mes courbes »
let helpReturn = 'done';  // écran de retour depuis le mode d'emploi

// --- Utilitaires ----------------------------------------------------------

function show(name) {
  Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== name; });
  document.getElementById('logoutBtn').hidden = (name === 'connect');
  const who = document.getElementById('whoami');
  who.hidden = (name === 'connect') || !patient;
  if (patient && patient.pseudo) who.textContent = `Pseudo : ${patient.pseudo}`;
}
function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'm-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}
function loadQueue() { try { return JSON.parse(localStorage.getItem(LS_QUEUE)) || []; } catch { return []; } }
function saveQueue(q) { localStorage.setItem(LS_QUEUE, JSON.stringify(q)); }

function updateNet() {
  const online = navigator.onLine;
  netStatus.textContent = online ? 'En ligne' : 'Hors ligne';
  netStatus.classList.toggle('online', online);
  updatePendingNote();
}
function updatePendingNote() {
  const n = loadQueue().length;
  const note = document.getElementById('pendingNote');
  if (n > 0) { note.hidden = false; note.textContent = `${n} saisie(s) en attente d'envoi.`; }
  else note.hidden = true;
}

function openHelp(returnTo) { helpReturn = returnTo || 'done'; show('help'); }

// --- Mes courbes (vue patient) -------------------------------------------

async function openCharts(returnTo) {
  chartReturn = returnTo || 'done';
  const box = document.getElementById('patientCharts');
  box.innerHTML = '<p class="muted">Chargement…</p>';
  show('chart');
  if (!navigator.onLine) { box.innerHTML = '<p class="muted">Indisponible hors ligne. Reconnectez-vous au réseau pour voir vos courbes.</p>'; return; }
  try {
    const res = await fetch(`${API}/api/interventions/${patient.id}/series`);
    if (!res.ok) throw new Error();
    const s = await res.json();
    const html = miniChart('Douleur', s.pain, '#0E7C7B') + miniChart('Sommeil', s.sleep, '#2e7d6b');
    box.innerHTML = html || '<p class="muted">Aucune saisie pour le moment.</p>';
  } catch { box.innerHTML = '<p class="muted">Impossible de récupérer vos courbes pour le moment.</p>'; }
}

function miniChart(title, ms, color) {
  const pts = (ms && ms.points) || [], missed = (ms && ms.missed) || [];
  if (!ms || (!ms.scenario && !pts.length)) return '';
  if (!pts.length) return `<div class="mini"><h3>${title}</h3><p class="muted">Aucune saisie pour le moment.</p></div>`;
  const W = 320, H = 150, padL = 22, padR = 10, padT = 10, padB = 20;
  const all = pts.concat(missed).map((p) => new Date(p.t).getTime());
  let t0 = Math.min(...all), t1 = Math.max(...all); if (t1 === t0) t1 = t0 + 3600000;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const x = (t) => padL + ((new Date(t).getTime() - t0) / (t1 - t0)) * plotW;
  const y = (v) => padT + plotH - (Math.max(0, Math.min(10, v)) / 10) * plotH;
  const out = [`<div class="mini"><h3>${title}</h3><svg viewBox="0 0 ${W} ${H}" class="mini-svg">`];
  for (let v = 0; v <= 10; v += 5) { const yy = y(v); out.push(`<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#eef2f4"/><text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-size="9" fill="#5B6B7A">${v}</text>`); }
  // Dates en bas (début · milieu · fin)
  const fmtD = (t) => new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  const labY = H - 6;
  out.push(`<text x="${padL}" y="${labY}" text-anchor="start" font-size="9" fill="#5B6B7A">${fmtD(t0)}</text>`);
  if (t1 - t0 > 36 * 3600 * 1000) out.push(`<text x="${padL + plotW / 2}" y="${labY}" text-anchor="middle" font-size="9" fill="#5B6B7A">${fmtD((t0 + t1) / 2)}</text>`);
  out.push(`<text x="${W - padR}" y="${labY}" text-anchor="end" font-size="9" fill="#5B6B7A">${fmtD(t1)}</text>`);
  if (pts.length > 1) out.push(`<path d="${pts.map((q, i) => `${i ? 'L' : 'M'}${x(q.t).toFixed(1)} ${y(q.value).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`);
  missed.forEach((m) => { const r = 3.2, xx = x(m.t), yy = y(m.value); out.push(`<path d="M${(xx - r).toFixed(1)} ${(yy - r).toFixed(1)} L${(xx + r).toFixed(1)} ${(yy + r).toFixed(1)} M${(xx - r).toFixed(1)} ${(yy + r).toFixed(1)} L${(xx + r).toFixed(1)} ${(yy - r).toFixed(1)}" stroke="#9AA8B4" stroke-width="1.6"/>`); });
  pts.forEach((q) => {
    const xx = x(q.t).toFixed(1), yy = y(q.value).toFixed(1);
    if (q.kind === 'spontaneous') out.push(`<circle cx="${xx}" cy="${yy}" r="3.6" fill="#fff" stroke="${q.outOfBounds ? '#C0392B' : color}" stroke-width="2"/>`);
    else out.push(`<circle cx="${xx}" cy="${yy}" r="${q.outOfBounds ? 4.2 : 3.4}" fill="${q.outOfBounds ? '#C0392B' : color}"/>`);
  });
  const hasAlert = pts.some((p) => p.outOfBounds);
  const legend = `<span style="color:${color}">●</span> à l'heure · ○ saisie spontanée · × créneau manqué`
    + (hasAlert ? ` · <span style="color:#C0392B">●</span> au-dessus du seuil` : '');
  out.push(`</svg><p class="mini-legend">${legend}</p></div>`);
  return out.join('');
}

// --- Définition des métriques --------------------------------------------

const META = {
  pain: {
    title: 'Votre douleur en ce moment ?',
    min: '0 · aucune', max: '10 · insupportable',
    gradient: 'linear-gradient(90deg, #66bb6a, #ffd54f, #e57373)', // vert -> rouge
    start: 0,
  },
  sleep: {
    title: 'Qualité de votre sommeil ?',
    min: '0 · très mauvais', max: '10 · excellent',
    gradient: 'linear-gradient(90deg, #e57373, #ffd54f, #66bb6a)', // rouge -> vert
    start: 5,
  },
};
function metaFor(metric) { return META[metric] || META.pain; }
function stepFor(metric) { return steps[currentStep]; }
function precisionStep(precision) { return precision === 2 ? 0.01 : precision === 1 ? 0.1 : 1; }

function buildSteps() {
  const order = (m) => (m === 'pain' ? 0 : 1);
  let list = (scenarios || [])
    .map((s) => ({ metric: s.metric || 'pain', precision: s.precision || 0, name: s.name, optional: (s.metric === 'sleep') }))
    .sort((a, b) => order(a.metric) - order(b.metric));
  // un seul step par métrique
  const seen = new Set();
  list = list.filter((st) => (seen.has(st.metric) ? false : (seen.add(st.metric), true)));
  if (!list.length) list = [{ metric: 'pain', precision: 1, name: 'Douleur', optional: false }];
  return list;
}

// --- Connexion ------------------------------------------------------------

async function connect(pseudo) {
  const err = document.getElementById('connectError');
  err.hidden = true;
  if (!pseudo) { err.textContent = 'Veuillez saisir un pseudo.'; err.hidden = false; return; }

  if (navigator.onLine) {
    try {
      const res = await fetch(`${API}/api/interventions/by-pseudo/${encodeURIComponent(pseudo)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        err.textContent = body.error || 'Pseudo inconnu.'; err.hidden = false; return;
      }
      const data = await res.json();
      patient = { id: data.intervention.id, pseudo: data.intervention.pseudo };
      scenarios = data.scenarios || [];
      localStorage.setItem(LS_PATIENT, JSON.stringify({ ...patient, scenarios }));
    } catch {
      err.textContent = 'Connexion impossible. Réessayez avec du réseau.'; err.hidden = false; return;
    }
  } else {
    const stored = JSON.parse(localStorage.getItem(LS_PATIENT) || 'null');
    if (stored && stored.pseudo === pseudo) { patient = { id: stored.id, pseudo: stored.pseudo }; scenarios = stored.scenarios || []; }
    else { err.textContent = 'Hors ligne : première connexion impossible à vérifier.'; err.hidden = false; return; }
  }
  startSequence();
}

// --- Séquence de saisie ---------------------------------------------------

function startSequence() {
  steps = buildSteps();
  collected = [];
  currentStep = 0;
  sessionTime = new Date().toISOString();
  renderStep();
  updatePendingNote();
}

function renderStep() {
  const st = steps[currentStep];
  const meta = metaFor(st.metric);
  document.getElementById('gaugeStep').textContent = steps.length > 1 ? `Étape ${currentStep + 1} / ${steps.length}` : '';
  document.getElementById('gaugeTitle').textContent = meta.title;
  document.getElementById('gaugeMinLabel').textContent = meta.min;
  document.getElementById('gaugeMaxLabel').textContent = meta.max;
  slider.step = precisionStep(st.precision);
  slider.min = 0; slider.max = 10;
  slider.value = meta.start;
  slider.style.background = meta.gradient;
  updateGaugeOutput();
  document.getElementById('gaugeSkip').hidden = !st.optional;
  show('gauge');
}

function updateGaugeOutput() {
  const st = steps[currentStep];
  document.getElementById('gaugeValue').textContent = Number(slider.value).toFixed(st.precision);
}

function validateStep() {
  const st = steps[currentStep];
  collected.push({ clientId: uuid(), type: st.metric, value: Number(slider.value), recordedAt: sessionTime, source: 'spontaneous' });
  nextStep();
}
function skipStep() { nextStep(); }

function nextStep() {
  currentStep += 1;
  if (currentStep < steps.length) renderStep();
  else finishSequence();
}

async function finishSequence() {
  const sent = await sendMeasurements(patient.id, collected);
  const summary = collected.map((m) => {
    const st = steps.find((s) => s.metric === m.type);
    const label = m.type === 'sleep' ? 'sommeil' : 'douleur';
    return `${label} ${Number(m.value).toFixed(st ? st.precision : 0)}/10`;
  }).join(', ');
  document.getElementById('doneDetail').textContent = (summary ? summary.charAt(0).toUpperCase() + summary.slice(1) : 'Saisie')
    + (sent ? ' — envoyé.' : ' — enregistré, envoi au retour du réseau.');
  show('done');
}

async function sendMeasurements(patientId, items) {
  if (!items.length) return true;
  if (navigator.onLine) {
    try {
      const res = await fetch(`${API}/api/interventions/${patientId}/measurements`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
      });
      if (res.ok) return true;
    } catch { /* file d'attente */ }
  }
  const q = loadQueue();
  items.forEach((m) => q.push({ patientId, measurement: m }));
  saveQueue(q);
  updatePendingNote();
  return false;
}

async function flushQueue() {
  if (!navigator.onLine) return;
  let q = loadQueue();
  if (!q.length) return;
  const byPatient = {};
  q.forEach((e) => { (byPatient[e.patientId] = byPatient[e.patientId] || []).push(e.measurement); });
  const stillPending = [];
  for (const [pid, items] of Object.entries(byPatient)) {
    try {
      const res = await fetch(`${API}/api/interventions/${pid}/measurements`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
      });
      if (!res.ok) items.forEach((m) => stillPending.push({ patientId: pid, measurement: m }));
    } catch { items.forEach((m) => stillPending.push({ patientId: pid, measurement: m })); }
  }
  saveQueue(stillPending);
  updatePendingNote();
}

// --- Déconnexion / rappel démo -------------------------------------------

function logout() {
  localStorage.removeItem(LS_PATIENT);
  patient = null; scenarios = []; steps = []; collected = [];
  const input = document.getElementById('pseudoInput');
  if (input) input.value = '';
  show('connect');
}

async function scheduleReminder() {
  if (!('Notification' in window)) { alert('Notifications indisponibles sur cet appareil.'); return; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return;
  setTimeout(() => new Notification('Suricate', { body: 'C\'est l\'heure de votre saisie.' }), 10000);
  alert('Rappel de test programmé dans 10 secondes.');
}

// --- Init -----------------------------------------------------------------

function init() {
  document.getElementById('connectBtn').addEventListener('click', () => connect(document.getElementById('pseudoInput').value.trim()));
  document.getElementById('pseudoInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(e.target.value.trim()); });
  slider.addEventListener('input', updateGaugeOutput);
  document.getElementById('gaugeValidate').addEventListener('click', validateStep);
  document.getElementById('gaugeSkip').addEventListener('click', skipStep);
  document.getElementById('againBtn').addEventListener('click', startSequence);
  document.getElementById('chartsBtn').addEventListener('click', () => openCharts('done'));
  document.getElementById('chartsFromGauge').addEventListener('click', () => openCharts('gauge'));
  document.getElementById('chartBackBtn').addEventListener('click', () => show(chartReturn));
  document.getElementById('chartAgainBtn').addEventListener('click', startSequence);
  document.getElementById('helpFromChart').addEventListener('click', () => openHelp('chart'));
  document.getElementById('manualReminder').addEventListener('click', scheduleReminder);
  document.getElementById('helpBtn').addEventListener('click', () => openHelp('done'));
  document.getElementById('backBtn').addEventListener('click', () => show(helpReturn));
  document.getElementById('logoutBtn').addEventListener('click', logout);

  window.addEventListener('online', () => { updateNet(); flushQueue(); });
  window.addEventListener('offline', updateNet);
  updateNet();

  const stored = JSON.parse(localStorage.getItem(LS_PATIENT) || 'null');
  if (stored) { patient = { id: stored.id, pseudo: stored.pseudo }; scenarios = stored.scenarios || []; flushQueue(); startSequence(); }
  else show('connect');

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
