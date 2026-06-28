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

// --- Utilitaires ----------------------------------------------------------

function show(name) {
  Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== name; });
  document.getElementById('logoutBtn').hidden = (name === 'connect');
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
      const res = await fetch(`${API}/api/patients/by-pseudo/${encodeURIComponent(pseudo)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        err.textContent = body.error || 'Pseudo inconnu.'; err.hidden = false; return;
      }
      const data = await res.json();
      patient = { id: data.patient.id, pseudo: data.patient.pseudo };
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
  collected.push({ clientId: uuid(), type: st.metric, value: Number(slider.value), recordedAt: sessionTime });
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
      const res = await fetch(`${API}/api/patients/${patientId}/measurements`, {
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
      const res = await fetch(`${API}/api/patients/${pid}/measurements`, {
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
  document.getElementById('manualReminder').addEventListener('click', scheduleReminder);
  document.getElementById('helpBtn').addEventListener('click', () => show('help'));
  document.getElementById('backBtn').addEventListener('click', () => show('done'));
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
