'use strict';

/* Suricate — tableau de bord médecin (MVP-0).
   - Liste des patients (pseudonymes) et création
   - Correspondance pseudo<=>nom conservée UNIQUEMENT dans ce navigateur
   - Création de scénarios (phases + gabarit de douleur)
   - Courbe d'évolution dessinée en SVG (sans dépendance), avec enveloppe
     « gabarit » et mise en évidence des points hors-gabarit (alertes). */

const API = '';
const LS_NAMES = 'suricate.doctor.names'; // { patientId: nom }

let scenarios = [];
let patients = [];
let activePatientId = null;

// --- Correspondance locale pseudo <=> nom --------------------------------

function loadNames() {
  try { return JSON.parse(localStorage.getItem(LS_NAMES)) || {}; }
  catch { return {}; }
}
function saveName(patientId, name) {
  const map = loadNames();
  if (name) map[patientId] = name; else delete map[patientId];
  localStorage.setItem(LS_NAMES, JSON.stringify(map));
}
function nameFor(patientId, fallback) {
  return loadNames()[patientId] || fallback;
}

// --- API ------------------------------------------------------------------

async function api(path, opts) {
  const res = await fetch(`${API}/api${path}`, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Erreur ${res.status}`);
  return body;
}

// --- Chargement -----------------------------------------------------------

async function refresh() {
  [scenarios, patients] = await Promise.all([api('/scenarios'), api('/patients')]);
  renderScenarioList();
  fillScenarioSelect();
  await renderPatientList();
}

async function renderPatientList() {
  const ul = document.getElementById('patientList');
  ul.innerHTML = '';
  // Pour l'indicateur d'alerte, on récupère la série de chaque patient.
  const series = await Promise.all(
    patients.map((p) => api(`/patients/${p.id}/series`).catch(() => null))
  );
  patients.forEach((p, i) => {
    const s = series[i];
    const li = document.createElement('li');
    li.dataset.id = p.id;
    if (p.id === activePatientId) li.classList.add('active');
    const alert = s && s.alertActive;
    li.innerHTML = `
      <span class="dot ${alert ? 'alert' : ''}" title="${alert ? 'Alerte active' : 'Aucune alerte'}"></span>
      <span>
        <span class="name">${escapeHtml(nameFor(p.id, p.pseudo))}</span><br>
        <span class="pseudo">${escapeHtml(p.pseudo)}</span>
      </span>`;
    li.addEventListener('click', () => openPatient(p.id));
    ul.appendChild(li);
  });
}

function renderScenarioList() {
  const ul = document.getElementById('scenarioList');
  ul.innerHTML = '';
  scenarios.forEach((s) => {
    const li = document.createElement('li');
    const phasesHtml = (s.phases || []).map((p) =>
      `${escapeHtml(p.label)} : ${p.days} j, toutes les ${humanizeMinutes(p.frequencyMinutes)}`
    ).join('<br>');
    li.innerHTML = `<span><span class="name">${escapeHtml(s.name)}</span><br>
      <span class="pseudo">gabarit ${s.gabarit.min}–${s.gabarit.max} · ${s.phases.length} phase(s)</span>
      ${phasesHtml ? `<br><span class="pseudo">${phasesHtml}</span>` : ''}</span>`;
    ul.appendChild(li);
  });
}

function fillScenarioSelect() {
  const sel = document.getElementById('fScenario');
  sel.innerHTML = '';
  scenarios.forEach((s) => {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.name;
    sel.appendChild(o);
  });
}

// --- Détail patient + graphique ------------------------------------------

async function openPatient(id) {
  activePatientId = id;
  document.querySelectorAll('#patientList li').forEach((li) =>
    li.classList.toggle('active', li.dataset.id === id));
  document.getElementById('patientForm').hidden = true;
  document.getElementById('emptyState').hidden = true;

  const s = await api(`/patients/${id}/series`);
  const detail = document.getElementById('patientDetail');
  detail.hidden = false;

  document.getElementById('dName').textContent = nameFor(id, s.patient.pseudo);
  const meta = [
    `pseudo : ${s.patient.pseudo}`,
    s.patient.operation && `opération : ${s.patient.operation}`,
    s.patient.ageRange && `âge : ${s.patient.ageRange}`,
    s.patient.sex && `sexe : ${s.patient.sex}`,
    s.scenario && `scénario : ${s.scenario.name}`,
  ].filter(Boolean).join('  ·  ');
  document.getElementById('dMeta').textContent = meta;

  const banner = document.getElementById('alertBanner');
  if (s.alertActive) {
    banner.hidden = false;
    banner.textContent = `⚠ Alerte : ${s.alerts.length} mesure(s) hors du gabarit (${s.gabarit.min}–${s.gabarit.max}).`;
  } else {
    banner.hidden = true;
  }

  drawChart(document.getElementById('chart'), s);
}

/* Graphique SVG fait main : axes, bande de gabarit, ligne, points.
   Aucune librairie externe -> le dépôt reste autonome et hors-ligne. */
function drawChart(container, s) {
  const W = 720, H = 320, padL = 40, padR = 16, padT = 16, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const points = s.points;

  const yMin = 0, yMax = 10;
  const y = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  let xOf;
  if (points.length <= 1) {
    xOf = () => padL + plotW / 2;
  } else {
    const t0 = new Date(points[0].t).getTime();
    const t1 = new Date(points[points.length - 1].t).getTime();
    const span = Math.max(1, t1 - t0);
    xOf = (t) => padL + ((new Date(t).getTime() - t0) / span) * plotW;
  }

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de douleur">`);

  // Bande gabarit
  const gy1 = y(s.gabarit.max), gy2 = y(s.gabarit.min);
  parts.push(`<rect x="${padL}" y="${gy1}" width="${plotW}" height="${gy2 - gy1}"
    fill="rgba(14,124,123,.12)" stroke="rgba(14,124,123,.35)" stroke-dasharray="4 3"/>`);

  // Grille + axe Y (0..10)
  for (let v = 0; v <= 10; v += 2) {
    const yy = y(v);
    parts.push(`<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#eef2f4"/>`);
    parts.push(`<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#5B6B7A">${v}</text>`);
  }

  // Axe X (dates première/dernière)
  if (points.length) {
    const fmt = (t) => new Date(t).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
    parts.push(`<text x="${padL}" y="${H - 14}" font-size="11" fill="#5B6B7A">${fmt(points[0].t)}</text>`);
    parts.push(`<text x="${W - padR}" y="${H - 14}" text-anchor="end" font-size="11" fill="#5B6B7A">${fmt(points[points.length - 1].t)}</text>`);
  }

  // Ligne
  if (points.length > 1) {
    const d = points.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="#0E7C7B" stroke-width="2.5" stroke-linejoin="round"/>`);
  }

  // Points
  points.forEach((p) => {
    const cx = xOf(p.t), cy = y(p.value);
    const color = p.outOfBounds ? '#C0392B' : '#0E7C7B';
    const r = p.outOfBounds ? 6 : 4.5;
    parts.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${color}" stroke="#fff" stroke-width="1.5"><title>${p.value}/10 — ${new Date(p.t).toLocaleString('fr-FR')}</title></circle>`);
  });

  if (!points.length) {
    parts.push(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="#5B6B7A">Aucune mesure pour l'instant.</text>`);
  }

  parts.push('</svg>');
  container.innerHTML = parts.join('');
}

// --- Création patient -----------------------------------------------------

function showPatientForm() {
  document.getElementById('patientDetail').hidden = true;
  document.getElementById('emptyState').hidden = true;
  document.getElementById('patientForm').hidden = false;
  ['fName', 'fPseudo', 'fOperation', 'fAge'].forEach((id) => (document.getElementById(id).value = ''));
}

async function savePatient() {
  const err = document.getElementById('patientFormError');
  err.hidden = true;
  const name = document.getElementById('fName').value.trim();
  const payload = {
    pseudo: document.getElementById('fPseudo').value.trim(),
    scenarioId: document.getElementById('fScenario').value,
    operation: document.getElementById('fOperation').value.trim(),
    ageRange: document.getElementById('fAge').value.trim(),
    sex: document.getElementById('fSex').value,
  };
  try {
    const patient = await api('/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    saveName(patient.id, name); // le nom reste local
    await refresh();
    openPatient(patient.id);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

// --- Création scénario ----------------------------------------------------

// Conversions durée <-> minutes (pour saisir en j/h/min)
function splitMinutes(total) {
  total = Math.max(0, Number(total) || 0);
  return {
    d: Math.floor(total / 1440),
    h: Math.floor((total % 1440) / 60),
    m: total % 60,
  };
}
function humanizeMinutes(total) {
  total = Number(total) || 0;
  if (!total) return '—';
  const { d, h, m } = splitMinutes(total);
  const parts = [];
  if (d) parts.push(`${d} j`);
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  return parts.join(' ');
}

function addPhaseRow(label = '', days = '', freqMinutes = '') {
  const wrap = document.getElementById('phaseRows');
  const row = document.createElement('div');
  row.className = 'phase-row';
  const f = freqMinutes === '' ? { d: '', h: '', m: '' } : splitMinutes(freqMinutes);
  row.innerHTML = `
    <label>Libellé<input class="p-label" type="text" value="${escapeAttr(label)}" placeholder="ex. Phase aiguë"></label>
    <label>Durée (jours)<input class="p-days" type="number" min="1" value="${days}"></label>
    <div class="p-freq-cell">
      <span class="p-freq-title">Fréquence de saisie (toutes les…)</span>
      <div class="p-freq-group">
        <label>jours<input class="p-fd" type="number" min="0" value="${f.d}" placeholder="0"></label>
        <label>heures<input class="p-fh" type="number" min="0" max="23" value="${f.h}" placeholder="0"></label>
        <label>min<input class="p-fm" type="number" min="0" max="59" value="${f.m}" placeholder="0"></label>
      </div>
    </div>
    <button class="rm" title="Supprimer" type="button">×</button>`;
  row.querySelector('.rm').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

async function saveScenario() {
  const err = document.getElementById('scenarioFormError');
  err.hidden = true;
  const rows = [...document.querySelectorAll('#phaseRows .phase-row')];
  const phases = [];
  let partial = false;
  rows.forEach((r) => {
    const label = r.querySelector('.p-label').value.trim();
    const days = Number(r.querySelector('.p-days').value);
    const fd = Number(r.querySelector('.p-fd').value) || 0;
    const fh = Number(r.querySelector('.p-fh').value) || 0;
    const fm = Number(r.querySelector('.p-fm').value) || 0;
    const frequencyMinutes = fd * 1440 + fh * 60 + fm;
    if (!label && !days && !frequencyMinutes) return; // ligne vide ignorée
    if (!label || !days || !frequencyMinutes) { partial = true; return; }
    phases.push({ label, days, frequencyMinutes });
  });
  if (partial) {
    err.textContent = 'Chaque phase doit avoir un libellé, une durée en jours et une fréquence non nulle.';
    err.hidden = false;
    return;
  }

  const payload = {
    name: document.getElementById('sName').value.trim(),
    description: document.getElementById('sDesc').value.trim(),
    gabarit: {
      min: Number(document.getElementById('sMin').value),
      max: Number(document.getElementById('sMax').value),
    },
    phases,
  };
  if (!payload.name) { err.textContent = 'Le nom du scénario est obligatoire.'; err.hidden = false; return; }
  try {
    await api('/scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    document.getElementById('sName').value = '';
    document.getElementById('sDesc').value = '';
    document.getElementById('phaseRows').innerHTML = '';
    addPhaseRow();
    await refresh();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

// --- Onglets & init -------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.getElementById('tab-patients').hidden = name !== 'patients';
  document.getElementById('tab-scenarios').hidden = name !== 'scenarios';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

function init() {
  document.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => switchTab(t.dataset.tab)));
  document.getElementById('newPatientBtn').addEventListener('click', showPatientForm);
  document.getElementById('savePatient').addEventListener('click', savePatient);
  document.getElementById('cancelPatient').addEventListener('click', () => {
    document.getElementById('patientForm').hidden = true;
    document.getElementById('emptyState').hidden = false;
  });
  document.getElementById('addPhase').addEventListener('click', () => addPhaseRow());
  document.getElementById('saveScenario').addEventListener('click', saveScenario);
  addPhaseRow();

  refresh().catch((e) => {
    document.getElementById('emptyState').innerHTML =
      `<p class="error">Impossible de joindre le serveur : ${escapeHtml(e.message)}</p>`;
  });
}

init();
