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
let editingScenarioId = null;

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
  renderScenarioChecklist();
  fillCopyFromSelect();
  await renderPatientList();
}

function metricLabel(m) { return m === 'sleep' ? 'Sommeil' : 'Douleur'; }

async function renderPatientList() {
  const ul = document.getElementById('patientList');
  ul.innerHTML = '';
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
    if (s.id === editingScenarioId) li.classList.add('active');
    const phasesHtml = (s.phases || []).map((p) => {
      const seuil = (p.gabaritStart == null || p.gabaritEnd == null) ? '—' : `${p.gabaritStart}→${p.gabaritEnd}`;
      return `${escapeHtml(p.label)} : ${p.days} j, toutes les ${humanizeMinutes(p.frequencyMinutes)}, seuil ${seuil}`;
    }).join('<br>');
    li.innerHTML = `<span><span class="name">${escapeHtml(s.name)}</span><br>
      <span class="pseudo">${metricLabel(s.metric)} · ${s.precision || 0} déc. · ${s.phases.length} phase(s)</span>
      ${phasesHtml ? `<br><span class="pseudo">${phasesHtml}</span>` : ''}</span>`;
    li.addEventListener('click', () => editScenario(s.id));
    ul.appendChild(li);
  });
}

// Liste à cocher des scénarios pour l'affectation à un patient.
function renderScenarioChecklist() {
  const box = document.getElementById('fScenarios');
  box.innerHTML = '';
  if (!scenarios.length) { box.innerHTML = '<p class="muted">Aucun scénario : créez-en d\'abord un dans l\'onglet Scénarios.</p>'; return; }
  scenarios.forEach((s) => {
    const id = `chk-${s.id}`;
    const row = document.createElement('label');
    row.className = 'check-row';
    row.innerHTML = `<input type="checkbox" id="${id}" value="${s.id}">
      <span><span class="name">${escapeHtml(s.name)}</span>
      <span class="pseudo">${metricLabel(s.metric)} · ${s.precision || 0} déc.</span></span>`;
    box.appendChild(row);
  });
}

function fillCopyFromSelect() {
  const sel = document.getElementById('sCopyFrom');
  sel.innerHTML = '<option value="">— vierge —</option>';
  scenarios.forEach((s) => {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = `${s.name} (${metricLabel(s.metric)})`;
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
  const scnNames = (s.scenarios || []).map((sc) => `${sc.name} (${metricLabel(sc.metric)})`).join(', ');
  const meta = [
    `pseudo : ${s.patient.pseudo}`,
    s.patient.operation && `opération : ${s.patient.operation}`,
    s.patient.ageRange && `âge : ${s.patient.ageRange}`,
    s.patient.sex && `sexe : ${s.patient.sex}`,
    scnNames && `scénarios : ${scnNames}`,
  ].filter(Boolean).join('  ·  ');
  document.getElementById('dMeta').textContent = meta;

  const banner = document.getElementById('alertBanner');
  if (s.alertActive) {
    banner.hidden = false;
    banner.textContent = `⚠ Alerte : ${s.alerts.length} mesure(s) de douleur au-dessus du seuil.`;
  } else {
    banner.hidden = true;
  }

  currentSeries = s;
  chartZoom = 1;
  renderCharts();
  setBothScroll(0);
}

/* Graphiques SVG faits main (aucune librairie externe -> dépôt autonome).
   L'axe du temps couvre toute la durée du scénario (s.timeline). */

const CHART = { H: 300, padL: 40, padR: 16, padT: 14, padB: 40 };
const DAY = 24 * 60 * 60 * 1000;
let currentSeries = null;
let chartZoom = 1;
let scrollSyncing = false;

function chartHelpers(W, domain) {
  const { H, padL, padR, padT, padB } = CHART;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const y = (v) => padT + plotH - (Math.max(0, Math.min(10, v)) / 10) * plotH;
  const t0 = new Date(domain.start).getTime();
  const t1 = new Date(domain.end).getTime();
  const span = Math.max(1, t1 - t0);
  const x = (t) => padL + ((new Date(t).getTime() - t0) / span) * plotW;
  return { W, H, padL, padR, padT, padB, plotW, plotH, x, y };
}

function yGrid(h) {
  const parts = [];
  for (let v = 0; v <= 10; v += 2) {
    const yy = h.y(v);
    parts.push(`<line x1="${h.padL}" y1="${yy}" x2="${h.W - h.padR}" y2="${yy}" stroke="#eef2f4"/>`);
    parts.push(`<text x="${h.padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#5B6B7A">${v}</text>`);
  }
  return parts;
}

// Graduation des jours : tous les jours si la place le permet, sinon les lundis
// (puis 1 lundi sur N si encore trop serré). Le zoom densifie automatiquement.
function dayAxis(h, domain) {
  const parts = [];
  const startMs = new Date(domain.start).getTime();
  const endMs = new Date(domain.end).getTime();
  const day0 = new Date(startMs); day0.setHours(0, 0, 0, 0);
  const spacingDaily = h.plotW / Math.max(1, (endMs - startMs) / DAY);
  let mode = 'day', everyNthMonday = 1;
  if (spacingDaily < 38) {
    mode = 'week';
    const spacingWeekly = spacingDaily * 7;
    if (spacingWeekly < 38) everyNthMonday = Math.ceil(38 / spacingWeekly);
  }
  const baseY = h.padT + h.plotH;
  let d = new Date(day0), mondayIdx = 0;
  while (d.getTime() <= endMs) {
    let show = false;
    if (mode === 'day') show = true;
    else if (d.getDay() === 1) { show = (mondayIdx % everyNthMonday === 0); mondayIdx += 1; }
    if (show && d.getTime() >= startMs) {
      const xx = h.x(d);
      parts.push(`<line x1="${xx.toFixed(1)}" y1="${h.padT}" x2="${xx.toFixed(1)}" y2="${baseY}" stroke="#f1f5f6"/>`);
      const lbl = d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      parts.push(`<text x="${xx.toFixed(1)}" y="${h.H - 14}" text-anchor="middle" font-size="10" fill="#5B6B7A">${lbl}</text>`);
    }
    d.setDate(d.getDate() + 1);
  }
  return parts;
}

function svgOpen(W, label) {
  return `<svg width="${W}" height="${CHART.H}" viewBox="0 0 ${W} ${CHART.H}" role="img" aria-label="${label}">`;
}

function drawPainChart(container, s, W) {
  const h = chartHelpers(W, s.timeline);
  const pts = s.pain.points, env = s.pain.envelope || [];
  const parts = [svgOpen(W, "Courbe de douleur et seuil d'alerte")];
  if (env.length) {
    const top = env.map((e, i) => `${i ? 'L' : 'M'}${h.x(e.t).toFixed(1)} ${h.y(e.ceiling).toFixed(1)}`).join(' ');
    const x0 = h.x(env[0].t).toFixed(1), x1 = h.x(env[env.length - 1].t).toFixed(1), yb = h.y(0).toFixed(1);
    parts.push(`<path d="${top} L${x1} ${yb} L${x0} ${yb} Z" fill="rgba(14,124,123,.12)"/>`);
    parts.push(`<path d="${top}" fill="none" stroke="rgba(14,124,123,.55)" stroke-width="1.5" stroke-dasharray="5 3"/>`);
  }
  parts.push(...dayAxis(h, s.timeline), ...yGrid(h));
  if (pts.length > 1) {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${h.x(p.t).toFixed(1)} ${h.y(p.value).toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="#0E7C7B" stroke-width="2.5" stroke-linejoin="round"/>`);
  }
  const prec = (s.pain.scenario && s.pain.scenario.precision) || 0;
  pts.forEach((p) => {
    const color = p.outOfBounds ? '#C0392B' : '#0E7C7B';
    const r = p.outOfBounds ? 6 : 4.5;
    parts.push(`<circle cx="${h.x(p.t).toFixed(1)}" cy="${h.y(p.value).toFixed(1)}" r="${r}" fill="${color}" stroke="#fff" stroke-width="1.5"><title>${Number(p.value).toFixed(prec)}/10 — ${new Date(p.t).toLocaleString('fr-FR')}</title></circle>`);
  });
  if (!pts.length) parts.push(emptyMsg(h, 'Aucune mesure de douleur.'));
  parts.push('</svg>');
  container.innerHTML = parts.join('');
}

function drawSleepChart(container, s, W) {
  const h = chartHelpers(W, s.timeline);
  const pts = s.sleep.points;
  const parts = [svgOpen(W, 'Qualité du sommeil')];
  parts.push(...dayAxis(h, s.timeline), ...yGrid(h));
  if (pts.length > 1) {
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${h.x(p.t).toFixed(1)} ${h.y(p.value).toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="#2e7d6b" stroke-width="2.5" stroke-linejoin="round"/>`);
  }
  pts.forEach((p) => parts.push(`<circle cx="${h.x(p.t).toFixed(1)}" cy="${h.y(p.value).toFixed(1)}" r="4.5" fill="#2e7d6b" stroke="#fff" stroke-width="1.5"><title>Sommeil ${p.value}/10 — ${new Date(p.t).toLocaleString('fr-FR')}</title></circle>`));
  if (!pts.length) parts.push(emptyMsg(h, 'Aucune donnée de sommeil.'));
  parts.push('</svg>');
  container.innerHTML = parts.join('');
}

function emptyMsg(h, text) {
  return `<text x="${h.W / 2}" y="${h.H / 2}" text-anchor="middle" font-size="13" fill="#5B6B7A">${text}</text>`;
}

// --- Zoom (molette) + défilement (ascenseur) synchronisés -----------------

function renderCharts() {
  if (!currentSeries) return;
  const cEl = document.getElementById('chart');
  const baseW = Math.max(cEl.clientWidth || 600, 320);
  const W = Math.round(baseW * chartZoom);
  drawPainChart(cEl, currentSeries, W);
  drawSleepChart(document.getElementById('sleepChart'), currentSeries, W);
}

function setBothScroll(v) {
  const a = document.getElementById('chart'), b = document.getElementById('sleepChart');
  const max = Math.max(0, a.scrollWidth - a.clientWidth);
  const val = Math.max(0, Math.min(v, max));
  scrollSyncing = true; a.scrollLeft = val; b.scrollLeft = val; scrollSyncing = false;
}

function onChartWheel(e) {
  if (!currentSeries) return;
  e.preventDefault();
  const container = e.currentTarget;
  const offsetX = e.clientX - container.getBoundingClientRect().left;
  const contentX = container.scrollLeft + offsetX;
  const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
  const newZoom = Math.min(40, Math.max(1, chartZoom * factor));
  if (newZoom === chartZoom) return;
  const ratio = newZoom / chartZoom;
  chartZoom = newZoom;
  renderCharts();
  setBothScroll(contentX * ratio - offsetX);
}

function onChartScroll(e) {
  if (scrollSyncing) return;
  const other = e.currentTarget.id === 'chart'
    ? document.getElementById('sleepChart') : document.getElementById('chart');
  scrollSyncing = true; other.scrollLeft = e.currentTarget.scrollLeft; scrollSyncing = false;
}

// --- Création patient -----------------------------------------------------

function showPatientForm() {
  document.getElementById('patientDetail').hidden = true;
  document.getElementById('emptyState').hidden = true;
  document.getElementById('patientForm').hidden = false;
  ['fName', 'fPseudo', 'fOperation', 'fAge'].forEach((id) => (document.getElementById(id).value = ''));
  renderScenarioChecklist(); // décoché par défaut
}

async function savePatient() {
  const err = document.getElementById('patientFormError');
  err.hidden = true;
  const name = document.getElementById('fName').value.trim();
  const scenarioIds = [...document.querySelectorAll('#fScenarios input:checked')].map((c) => c.value);
  if (!scenarioIds.length) { err.textContent = 'Sélectionnez au moins un scénario.'; err.hidden = false; return; }
  const payload = {
    pseudo: document.getElementById('fPseudo').value.trim(),
    scenarioIds,
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

function addPhaseRow(label = '', days = '', freqMinutes = '', gs = '', ge = '') {
  const wrap = document.getElementById('phaseRows');
  const row = document.createElement('div');
  row.className = 'phase-row';
  const f = freqMinutes === '' ? { d: '', h: '', m: '' } : splitMinutes(freqMinutes);
  row.innerHTML = `
    <button class="rm" title="Supprimer la phase" type="button">×</button>
    <div class="phase-fields">
      <label class="f-label">Libellé<input class="p-label" type="text" value="${escapeAttr(label)}" placeholder="ex. Phase aiguë"></label>
      <label class="f-days">Durée (jours)<input class="p-days" type="number" min="1" value="${days}"></label>
      <div class="f-freq">
        <span class="p-freq-title">Fréquence de saisie (toutes les…)</span>
        <div class="p-freq-group">
          <label>jours<input class="p-fd" type="number" min="0" value="${f.d}" placeholder="0"></label>
          <label>heures<input class="p-fh" type="number" min="0" max="23" value="${f.h}" placeholder="0"></label>
          <label>min<input class="p-fm" type="number" min="0" max="59" value="${f.m}" placeholder="0"></label>
        </div>
      </div>
      <div class="f-seuil">
        <span class="p-freq-title">Seuil d'alerte (douleur max 0–10)</span>
        <div class="p-freq-group two">
          <label>début<input class="p-gs" type="number" min="0" max="10" value="${gs}" placeholder="ex. 8"></label>
          <label>fin<input class="p-ge" type="number" min="0" max="10" value="${ge}" placeholder="ex. 6"></label>
        </div>
      </div>
    </div>`;
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
    const gsRaw = r.querySelector('.p-gs').value;
    const geRaw = r.querySelector('.p-ge').value;
    if (!label && !days && !frequencyMinutes && gsRaw === '' && geRaw === '') return; // ligne vide
    if (!label || !days || !frequencyMinutes) { partial = true; return; }
    // Seuils optionnels, mais s'il y en a un, il faut les deux.
    if ((gsRaw === '') !== (geRaw === '')) { partial = true; return; }
    phases.push({
      label, days, frequencyMinutes,
      gabaritStart: gsRaw === '' ? null : Number(gsRaw),
      gabaritEnd: geRaw === '' ? null : Number(geRaw),
    });
  });
  if (partial) {
    err.textContent = 'Chaque phase a besoin d\'un libellé, d\'une durée et d\'une fréquence ; les seuils vont par paire (début + fin) ou se laissent vides.';
    err.hidden = false;
    return;
  }

  const payload = {
    name: document.getElementById('sName').value.trim(),
    description: document.getElementById('sDesc').value.trim(),
    metric: document.getElementById('sMetric').value,
    precision: Number(document.getElementById('sPrecision').value),
    phases,
  };
  if (!payload.name) { err.textContent = 'Le nom du scénario est obligatoire.'; err.hidden = false; return; }

  try {
    if (editingScenarioId) {
      await api(`/scenarios/${editingScenarioId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    } else {
      await api('/scenarios', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    }
    await refresh();
    newScenario();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
}

// --- Édition / duplication de scénario ------------------------------------

function populateScenarioForm(s) {
  document.getElementById('sName').value = s.name || '';
  document.getElementById('sDesc').value = s.description || '';
  document.getElementById('sMetric').value = s.metric || 'pain';
  document.getElementById('sPrecision').value = String(s.precision || 0);
  document.getElementById('phaseRows').innerHTML = '';
  (s.phases || []).forEach((p) => addPhaseRow(
    p.label, p.days, p.frequencyMinutes,
    p.gabaritStart == null ? '' : p.gabaritStart,
    p.gabaritEnd == null ? '' : p.gabaritEnd
  ));
  if (!s.phases || !s.phases.length) addPhaseRow();
}

function newScenario() {
  editingScenarioId = null;
  document.getElementById('scenarioFormTitle').textContent = 'Nouveau scénario';
  document.getElementById('saveScenario').textContent = 'Créer le scénario';
  document.getElementById('duplicateScenario').hidden = true;
  document.getElementById('sCopyFrom').value = '';
  document.getElementById('scenarioFormError').hidden = true;
  populateScenarioForm({ name: '', description: '', metric: 'pain', precision: 0, phases: [] });
  renderScenarioList();
}

function editScenario(id) {
  const s = scenarios.find((x) => x.id === id);
  if (!s) return;
  editingScenarioId = id;
  document.getElementById('scenarioFormTitle').textContent = 'Modifier le scénario';
  document.getElementById('saveScenario').textContent = 'Enregistrer les modifications';
  document.getElementById('duplicateScenario').hidden = false;
  document.getElementById('scenarioFormError').hidden = true;
  populateScenarioForm(s);
  renderScenarioList();
}

// "Partir d'un scénario existant" : pré-remplit en mode CRÉATION.
function copyFromScenario() {
  const id = document.getElementById('sCopyFrom').value;
  if (!id) return;
  const s = scenarios.find((x) => x.id === id);
  if (!s) return;
  editingScenarioId = null;
  document.getElementById('scenarioFormTitle').textContent = 'Nouveau scénario';
  document.getElementById('saveScenario').textContent = 'Créer le scénario';
  document.getElementById('duplicateScenario').hidden = true;
  populateScenarioForm({ ...s, name: `${s.name} (copie)` });
  renderScenarioList();
}

// Depuis l'édition : repartir comme nouveau (sans écraser l'original).
function duplicateScenario() {
  const name = document.getElementById('sName').value.trim();
  editingScenarioId = null;
  document.getElementById('scenarioFormTitle').textContent = 'Nouveau scénario';
  document.getElementById('saveScenario').textContent = 'Créer le scénario';
  document.getElementById('duplicateScenario').hidden = true;
  document.getElementById('sName').value = `${name} (copie)`;
  renderScenarioList();
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
  document.getElementById('newScenarioBtn').addEventListener('click', newScenario);
  document.getElementById('duplicateScenario').addEventListener('click', duplicateScenario);
  document.getElementById('sCopyFrom').addEventListener('change', copyFromScenario);
  addPhaseRow();

  // Zoom molette + défilement synchronisé sur les deux graphiques.
  ['chart', 'sleepChart'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('wheel', onChartWheel, { passive: false });
    el.addEventListener('scroll', onChartScroll, { passive: true });
  });
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { chartZoom = 1; renderCharts(); }, 150);
  });

  refresh().catch((e) => {
    document.getElementById('emptyState').innerHTML =
      `<p class="error">Impossible de joindre le serveur : ${escapeHtml(e.message)}</p>`;
  });
}

init();
