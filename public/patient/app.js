'use strict';

/* Suricate — logique de l'app patient (MVP-0).
   - Connexion par pseudo (la correspondance pseudo<=>nom reste chez le médecin)
   - Saisie de la douleur 0-10
   - Fonctionnement hors-ligne : file d'attente locale, envoi idempotent dès
     que le réseau revient (clientId unique par mesure). */

const API = '';
const LS_PATIENT = 'suricate.patient';
const LS_QUEUE = 'suricate.queue';

const screens = {
  connect: document.getElementById('screen-connect'),
  pain: document.getElementById('screen-pain'),
  done: document.getElementById('screen-done'),
  help: document.getElementById('screen-help'),
};
const netStatus = document.getElementById('netStatus');

let patient = null;
let selectedValue = null;

// --- Utilitaires ----------------------------------------------------------

function show(name) {
  Object.entries(screens).forEach(([k, el]) => { el.hidden = k !== name; });
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'm-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function loadQueue() {
  try { return JSON.parse(localStorage.getItem(LS_QUEUE)) || []; }
  catch { return []; }
}
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
  if (n > 0) {
    note.hidden = false;
    note.textContent = `${n} saisie(s) en attente d'envoi — elles partiront dès le retour du réseau.`;
  } else {
    note.hidden = true;
  }
}

// Couleur 0 (vert) -> 10 (rouge), pour rendre l'échelle parlante.
function painColor(v) {
  const hue = 130 - (v / 10) * 130; // 130=vert, 0=rouge
  return `hsl(${hue}, 62%, 78%)`;
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
        err.textContent = body.error || 'Pseudo inconnu.';
        err.hidden = false;
        return;
      }
      const data = await res.json();
      patient = { id: data.patient.id, pseudo: data.patient.pseudo };
      localStorage.setItem(LS_PATIENT, JSON.stringify(patient));
    } catch {
      err.textContent = 'Connexion impossible. Réessayez quand vous aurez du réseau.';
      err.hidden = false;
      return;
    }
  } else {
    // Hors-ligne : on ne peut pas valider le pseudo, mais s'il correspond à
    // celui déjà connu, on laisse l'utilisateur continuer.
    const stored = JSON.parse(localStorage.getItem(LS_PATIENT) || 'null');
    if (stored && stored.pseudo === pseudo) {
      patient = stored;
    } else {
      err.textContent = 'Hors ligne : impossible de vérifier ce pseudo pour la première connexion.';
      err.hidden = false;
      return;
    }
  }
  goToPain();
}

function goToPain() {
  selectedValue = null;
  document.getElementById('submitBtn').disabled = true;
  buildScale();
  updatePendingNote();
  show('pain');
}

// --- Échelle de douleur ---------------------------------------------------

function buildScale() {
  const scale = document.getElementById('scale');
  scale.innerHTML = '';
  for (let v = 0; v <= 10; v++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = v;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.setAttribute('aria-label', `Niveau ${v}`);
    b.style.background = painColor(v);
    b.addEventListener('click', () => selectValue(v, b));
    scale.appendChild(b);
  }
}

function selectValue(v, btn) {
  selectedValue = v;
  document.querySelectorAll('#scale button').forEach((b) => b.setAttribute('aria-checked', 'false'));
  btn.setAttribute('aria-checked', 'true');
  document.getElementById('submitBtn').disabled = false;
}

// --- Envoi / file d'attente ----------------------------------------------

async function submit() {
  if (selectedValue == null || !patient) return;
  const measurement = {
    clientId: uuid(),
    value: selectedValue,
    recordedAt: new Date().toISOString(),
  };

  let sent = false;
  if (navigator.onLine) {
    sent = await sendOne(patient.id, measurement);
  }
  if (!sent) {
    const q = loadQueue();
    q.push({ patientId: patient.id, measurement });
    saveQueue(q);
  }

  const detail = document.getElementById('doneDetail');
  detail.textContent = sent
    ? `Douleur ${measurement.value}/10 envoyée.`
    : `Douleur ${measurement.value}/10 enregistrée. Elle sera envoyée dès le retour du réseau.`;
  show('done');
}

async function sendOne(patientId, measurement) {
  try {
    const res = await fetch(`${API}/api/patients/${patientId}/measurements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(measurement),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function flushQueue() {
  if (!navigator.onLine) return;
  let q = loadQueue();
  if (!q.length) return;

  // Regroupe par patient et envoie en lot (l'API accepte { items: [...] }).
  const byPatient = {};
  q.forEach((entry) => {
    (byPatient[entry.patientId] = byPatient[entry.patientId] || []).push(entry.measurement);
  });

  const stillPending = [];
  for (const [patientId, items] of Object.entries(byPatient)) {
    try {
      const res = await fetch(`${API}/api/patients/${patientId}/measurements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!res.ok) items.forEach((m) => stillPending.push({ patientId, measurement: m }));
    } catch {
      items.forEach((m) => stillPending.push({ patientId, measurement: m }));
    }
  }
  saveQueue(stillPending);
  updatePendingNote();
}

// --- Rappel de démonstration ---------------------------------------------

async function scheduleReminder() {
  if (!('Notification' in window)) {
    alert('Les notifications ne sont pas disponibles sur cet appareil.');
    return;
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return;

  // Démo : rappel dans 10 s. NB : sur iOS les rappels programmés en
  // arrière-plan sont restreints — d'où le besoin d'une app native (MVP-2)
  // ou de notifications push serveur pour un usage réel.
  setTimeout(() => {
    new Notification('Suricate', { body: 'C\'est l\'heure de noter votre douleur.' });
  }, 10000);
  alert('Rappel de test programmé dans 10 secondes.');
}

// --- Initialisation -------------------------------------------------------

function init() {
  document.getElementById('connectBtn').addEventListener('click', () => {
    connect(document.getElementById('pseudoInput').value.trim());
  });
  document.getElementById('pseudoInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect(e.target.value.trim());
  });
  document.getElementById('submitBtn').addEventListener('click', submit);
  document.getElementById('againBtn').addEventListener('click', goToPain);
  document.getElementById('manualReminder').addEventListener('click', scheduleReminder);
  document.getElementById('helpBtn').addEventListener('click', () => show('help'));
  document.getElementById('backBtn').addEventListener('click', () => show('done'));

  window.addEventListener('online', () => { updateNet(); flushQueue(); });
  window.addEventListener('offline', updateNet);
  updateNet();

  const stored = JSON.parse(localStorage.getItem(LS_PATIENT) || 'null');
  if (stored) { patient = stored; flushQueue(); goToPain(); }
  else show('connect');

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
