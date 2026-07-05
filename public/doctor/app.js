'use strict';

/* Suricate — tableau de bord médecin.
   Onglets : Interventions / Patients / Scénarios.
   - Base RECHERCHE (serveur) : pseudo, sexe, âge, opération, mesures (anonyme).
   - Base PATIENT (ce poste)  : identité réelle (nom, contacts) en localStorage.
   Un patient (personne) peut avoir plusieurs interventions. */

const API = '';
const LS_PRIVATE = 'suricate.doctor.private'; // { patientId: {name,phone,email,address} }
const LS_NAMES = 'suricate.doctor.names';     // ancien format

let scenarios = [], patients = [], interventions = [];
let activeInterventionId = null, activePatientId = null, editingScenarioId = null;
let ficheTarget = null;                 // patientId concerné par la modale fiche
const alertByItv = {};                  // cache alerte par intervention

// --- Base confidentielle (poste médecin) ---------------------------------

function loadPrivate() { try { return JSON.parse(localStorage.getItem(LS_PRIVATE)) || {}; } catch { return {}; } }
function getPrivate(id) { return loadPrivate()[id] || {}; }
function setPrivate(id, rec) { const m = loadPrivate(); m[id] = { ...m[id], ...rec }; localStorage.setItem(LS_PRIVATE, JSON.stringify(m)); }
function nameFor(id, fallback) { return getPrivate(id).name || fallback; }
function migratePrivate() {
  try {
    const old = JSON.parse(localStorage.getItem(LS_NAMES) || 'null'); if (!old) return;
    const m = loadPrivate(); Object.entries(old).forEach(([id, name]) => { if (!m[id]) m[id] = { name }; });
    localStorage.setItem(LS_PRIVATE, JSON.stringify(m)); localStorage.removeItem(LS_NAMES);
  } catch { /* rien */ }
}

// --- Utilitaires ----------------------------------------------------------

async function api(path, opts) {
  const res = await fetch(`${API}/api${path}`, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Erreur ${res.status}`);
  return body;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const escapeAttr = escapeHtml;
const metricLabel = (m) => (m === 'sleep' ? 'Sommeil' : 'Douleur');
function personById(id) { return patients.find((p) => p.id === id); }
function personLabel(id) { const p = personById(id); return nameFor(id, p ? p.pseudo : '—'); }
function itvCountFor(patientId) { return interventions.filter((i) => i.patientId === patientId).length; }

// --- Fiches de démonstration (remplies localement pour le jeu de test) -----
// L'identité ne vient jamais du serveur ; pour la démo on génère des fiches
// plausibles (déterministes) pour les patients du jeu de test, modifiables.
const FN_F = ['Marie', 'Sophie', 'Camille', 'Julie', 'Nathalie', 'Isabelle', 'Claire', 'Émilie', 'Sandrine', 'Céline', 'Aurélie', 'Valérie', 'Hélène', 'Christine'];
const FN_M = ['Jean', 'Pierre', 'Michel', 'Philippe', 'Nicolas', 'Thomas', 'Julien', 'Laurent', 'Sébastien', 'David', 'Christophe', 'Olivier', 'Patrick', 'Alain'];
const LN = ['Martin', 'Bernard', 'Dubois', 'Robert', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Lefebvre', 'Garcia', 'Roux', 'Fournier', 'Girard', 'Bonnet', 'Lambert', 'Faure'];
const STREETS = ['rue des Lilas', 'avenue Jean Jaurès', 'rue du Languedoc', 'allée des Tilleuls', 'impasse des Violettes', 'rue de la Garonne', 'boulevard de Strasbourg', 'rue Saint-Rome'];
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function stripAccents(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function demoIdentity(p) {
  const h = hashStr(p.pseudo), female = p.sex === 'F';
  const first = (female ? FN_F : FN_M)[h % (female ? FN_F.length : FN_M.length)];
  const last = LN[(h >>> 3) % LN.length];
  const pair = (n) => String(10 + ((n >>> 0) % 90));
  const phone = `06 ${pair(h)} ${pair(h >>> 4)} ${pair(h >>> 8)} ${pair(h >>> 12)}`;
  const email = `${stripAccents(`${first}.${last}`).toLowerCase()}@exemple.fr`;
  const address = `${1 + (h % 180)} ${STREETS[(h >>> 5) % STREETS.length]}, 31000 Toulouse`;
  return { name: `${first} ${last}`, phone, email, address };
}
function seedDemoFiches() {
  const stored = loadPrivate();
  const demo = patients.filter((p) => /^P-\d+$/.test(p.pseudo));
  if (demo.length < 5 || demo.some((p) => p.id in stored)) return; // pas la démo, ou déjà rempli
  demo.forEach((p) => { stored[p.id] = demoIdentity(p); });
  localStorage.setItem(LS_PRIVATE, JSON.stringify(stored));
}

// --- Chargement -----------------------------------------------------------

async function refresh() {
  [scenarios, patients, interventions] = await Promise.all([api('/scenarios'), api('/patients'), api('/interventions')]);
  // Cache des alertes (pour les pastilles).
  const series = await Promise.all(interventions.map((i) => api(`/interventions/${i.id}/series`).catch(() => null)));
  interventions.forEach((i, k) => { alertByItv[i.id] = series[k] && series[k].alertActive; });
  seedDemoFiches();
  renderScenarioList(); fillCopyFromSelect();
  renderInterventionList(); renderPatientList();
}

// --- ONGLET INTERVENTIONS -------------------------------------------------

function renderInterventionList() {
  const ul = document.getElementById('interventionList');
  const q = document.getElementById('itvSearch').value.trim().toLowerCase();
  const alertOnly = document.getElementById('itvAlertOnly').checked;
  ul.innerHTML = '';
  interventions
    .filter((i) => !alertOnly || alertByItv[i.id])
    .filter((i) => !q || i.pseudo.toLowerCase().includes(q) || personLabel(i.patientId).toLowerCase().includes(q) || (i.operation || '').toLowerCase().includes(q))
    .forEach((i) => {
      const li = document.createElement('li');
      li.dataset.id = i.id;
      if (i.id === activeInterventionId) li.classList.add('active');
      const ico = alertByItv[i.id] ? '<span class="alert-ico" title="Alerte : mesure hors gabarit">⚠</span> ' : '';
      li.innerHTML = `<span class="dot ${alertByItv[i.id] ? 'alert' : ''}"></span>
        <span><span class="name">${ico}${escapeHtml(personLabel(i.patientId))}</span><br>
        <span class="pseudo">${escapeHtml(i.pseudo)} · ${escapeHtml(i.operation || '—')}</span></span>`;
      li.addEventListener('click', () => openIntervention(i.id));
      ul.appendChild(li);
    });
  if (!ul.children.length) ul.innerHTML = `<li class="muted">${alertOnly ? 'Aucune intervention en alerte.' : 'Aucun résultat.'}</li>`;
}

async function openIntervention(id) {
  activeInterventionId = id;
  document.querySelectorAll('#interventionList li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  document.getElementById('interventionForm').hidden = true;
  document.getElementById('emptyItv').hidden = true;
  document.getElementById('interventionDetail').hidden = false;

  const s = await api(`/interventions/${id}/series`);
  ficheTarget = s.patient ? s.patient.id : null;
  document.getElementById('dName').textContent = s.patient ? personLabel(s.patient.id) : s.intervention.pseudo;
  const meta = [
    `intervention : ${s.intervention.pseudo}`,
    s.intervention.operation && `opération : ${s.intervention.operation}`,
    s.patient && s.patient.ageRange && `âge : ${s.patient.ageRange}`,
    s.patient && s.patient.sex && `sexe : ${s.patient.sex}`,
    s.scenarios.length && `scénarios : ${s.scenarios.map((x) => `${x.name} (${metricLabel(x.metric)})`).join(', ')}`,
  ].filter(Boolean).join('  ·  ');
  document.getElementById('dMeta').textContent = meta;
  renderFiche('ficheBody', ficheTarget);

  const banner = document.getElementById('alertBanner');
  if (s.alertActive) { banner.hidden = false; banner.textContent = `⚠ Alerte : ${s.alerts.length} mesure(s) de douleur au-dessus du seuil.`; }
  else banner.hidden = true;

  setSeries(s);
}

function showInterventionForm(presetPatientId) {
  document.getElementById('interventionDetail').hidden = true;
  document.getElementById('emptyItv').hidden = true;
  document.getElementById('interventionForm').hidden = false;
  const sel = document.getElementById('iPatient');
  sel.innerHTML = '';
  patients.forEach((p) => { const o = document.createElement('option'); o.value = p.id; o.textContent = `${personLabel(p.id)} (${p.pseudo})`; sel.appendChild(o); });
  if (presetPatientId) sel.value = presetPatientId;
  document.getElementById('iPseudo').value = '';
  document.getElementById('iOperation').value = '';
  document.getElementById('iStart').value = new Date().toISOString().slice(0, 10);
  renderScenarioChecklist('iScenarios');
  document.getElementById('iError').hidden = true;
}

async function saveIntervention() {
  const err = document.getElementById('iError'); err.hidden = true;
  const scenarioIds = [...document.querySelectorAll('#iScenarios input:checked')].map((c) => c.value);
  if (!document.getElementById('iPatient').value) { err.textContent = 'Choisissez un patient.'; err.hidden = false; return; }
  if (!scenarioIds.length) { err.textContent = 'Sélectionnez au moins un scénario.'; err.hidden = false; return; }
  const startVal = document.getElementById('iStart').value;
  const payload = {
    patientId: document.getElementById('iPatient').value,
    pseudo: document.getElementById('iPseudo').value.trim(),
    operation: document.getElementById('iOperation').value.trim(),
    startDate: startVal ? new Date(`${startVal}T08:00:00`).toISOString() : new Date().toISOString(),
    scenarioIds,
  };
  try {
    const itv = await api('/interventions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await refresh(); switchTab('interventions'); openIntervention(itv.id);
  } catch (e) { err.textContent = e.message; err.hidden = false; }
}

// --- ONGLET PATIENTS ------------------------------------------------------

function renderPatientList() {
  const ul = document.getElementById('patientList');
  const q = document.getElementById('patSearch').value.trim().toLowerCase();
  ul.innerHTML = '';
  patients
    .filter((p) => !q || p.pseudo.toLowerCase().includes(q) || personLabel(p.id).toLowerCase().includes(q))
    .forEach((p) => {
      const n = itvCountFor(p.id);
      const li = document.createElement('li');
      li.dataset.id = p.id;
      if (p.id === activePatientId) li.classList.add('active');
      li.innerHTML = `<span><span class="name">${escapeHtml(personLabel(p.id))}</span>
        ${n > 1 ? '<span class="badge">déjà suivi</span>' : ''}<br>
        <span class="pseudo">${escapeHtml(p.pseudo)} · ${n} intervention(s)</span></span>`;
      li.addEventListener('click', () => openPatient(p.id));
      ul.appendChild(li);
    });
}

async function openPatient(id) {
  activePatientId = id;
  document.querySelectorAll('#patientList li').forEach((li) => li.classList.toggle('active', li.dataset.id === id));
  document.getElementById('patientForm').hidden = true;
  document.getElementById('emptyPat').hidden = true;
  document.getElementById('patientDetail').hidden = false;

  const p = personById(id);
  document.getElementById('pName').textContent = personLabel(id);
  const list = interventions.filter((i) => i.patientId === id);
  document.getElementById('pMeta').textContent = [
    `pseudo : ${p.pseudo}`, p.sex && `sexe : ${p.sex}`, p.ageRange && `âge : ${p.ageRange}`,
    `${list.length} intervention(s)`,
  ].filter(Boolean).join('  ·  ');
  renderFiche('ficheBody2', id);

  const ul = document.getElementById('patientItvList');
  ul.innerHTML = list.length ? '' : '<li class="muted">Aucune intervention.</li>';
  list.forEach((i) => {
    const li = document.createElement('li');
    const d = new Date(i.startDate).toLocaleDateString('fr-FR');
    li.innerHTML = `<span><strong>${escapeHtml(i.pseudo)}</strong> — ${escapeHtml(i.operation || '—')} <span class="muted">(début ${d})</span></span>
      <button class="btn btn-sm btn-ghost">Ouvrir</button>`;
    li.querySelector('button').addEventListener('click', () => { switchTab('interventions'); openIntervention(i.id); });
    ul.appendChild(li);
  });
}

function showPatientForm() {
  document.getElementById('patientDetail').hidden = true;
  document.getElementById('emptyPat').hidden = true;
  document.getElementById('patientForm').hidden = false;
  ['fName', 'fPhone', 'fEmail', 'fAddress', 'fAge'].forEach((id) => { document.getElementById(id).value = ''; });
  document.getElementById('fSex').value = '';
  document.getElementById('patError').hidden = true;
}

async function savePatient() {
  const err = document.getElementById('patError'); err.hidden = true;
  const priv = {
    name: document.getElementById('fName').value.trim(),
    phone: document.getElementById('fPhone').value.trim(),
    email: document.getElementById('fEmail').value.trim(),
    address: document.getElementById('fAddress').value.trim(),
  };
  try {
    const p = await api('/patients', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ageRange: document.getElementById('fAge').value.trim(), sex: document.getElementById('fSex').value }),
    });
    setPrivate(p.id, priv);
    await refresh(); openPatient(p.id);
  } catch (e) { err.textContent = e.message; err.hidden = false; }
}

// --- Fiche confidentielle (commune) ---------------------------------------

function renderFiche(elId, patientId) {
  const p = getPrivate(patientId);
  const row = (l, v) => `<dt>${l}</dt><dd>${v ? escapeHtml(v) : '<span class="muted">—</span>'}</dd>`;
  document.getElementById(elId).innerHTML = row('Nom', p.name) + row('Téléphone', p.phone) + row('E-mail', p.email) + row('Adresse', p.address);
}
function openFicheModal(patientId) {
  ficheTarget = patientId; if (!ficheTarget) return;
  const p = getPrivate(patientId);
  document.getElementById('mName').value = p.name || '';
  document.getElementById('mPhone').value = p.phone || '';
  document.getElementById('mEmail').value = p.email || '';
  document.getElementById('mAddress').value = p.address || '';
  document.getElementById('ficheModal').hidden = false;
}
function closeFicheModal() { document.getElementById('ficheModal').hidden = true; }
function saveFiche() {
  if (!ficheTarget) return;
  setPrivate(ficheTarget, {
    name: document.getElementById('mName').value.trim(),
    phone: document.getElementById('mPhone').value.trim(),
    email: document.getElementById('mEmail').value.trim(),
    address: document.getElementById('mAddress').value.trim(),
  });
  closeFicheModal();
  if (activeInterventionId && !document.getElementById('interventionDetail').hidden) { renderFiche('ficheBody', ficheTarget); document.getElementById('dName').textContent = personLabel(ficheTarget); }
  if (activePatientId && !document.getElementById('patientDetail').hidden) { renderFiche('ficheBody2', activePatientId); document.getElementById('pName').textContent = personLabel(activePatientId); }
  renderInterventionList(); renderPatientList();
}

// --- Scénarios ------------------------------------------------------------

function splitMinutes(total) { total = Math.max(0, Number(total) || 0); return { d: Math.floor(total / 1440), h: Math.floor((total % 1440) / 60), m: total % 60 }; }
function humanizeMinutes(total) { total = Number(total) || 0; if (!total) return '—'; const { d, h, m } = splitMinutes(total); const p = []; if (d) p.push(`${d} j`); if (h) p.push(`${h} h`); if (m) p.push(`${m} min`); return p.join(' '); }

function renderScenarioList() {
  const ul = document.getElementById('scenarioList'); ul.innerHTML = '';
  scenarios.forEach((s) => {
    const li = document.createElement('li');
    if (s.id === editingScenarioId) li.classList.add('active');
    const ph = (s.phases || []).map((p) => {
      const seuil = (p.gabaritStart == null || p.gabaritEnd == null) ? '—' : `${p.gabaritStart}→${p.gabaritEnd}`;
      return `${escapeHtml(p.label)} : ${p.days} j, toutes les ${humanizeMinutes(p.frequencyMinutes)}, seuil ${seuil}`;
    }).join('<br>');
    const off = s.startOffsetMinutes ? ` · décalage ${humanizeMinutes(s.startOffsetMinutes)}` : '';
    li.innerHTML = `<span><span class="name">${escapeHtml(s.name)}</span><br>
      <span class="pseudo">${metricLabel(s.metric)} · ${s.precision || 0} déc.${off}</span>
      ${ph ? `<br><span class="pseudo">${ph}</span>` : ''}</span>`;
    li.addEventListener('click', () => editScenario(s.id));
    ul.appendChild(li);
  });
}
function renderScenarioChecklist(boxId) {
  const box = document.getElementById(boxId); box.innerHTML = '';
  if (!scenarios.length) { box.innerHTML = '<p class="muted">Aucun scénario : créez-en un d\'abord.</p>'; return; }
  scenarios.forEach((s) => {
    const row = document.createElement('label'); row.className = 'check-row';
    row.innerHTML = `<input type="checkbox" value="${s.id}"><span><span class="name">${escapeHtml(s.name)}</span>
      <span class="pseudo">${metricLabel(s.metric)} · ${s.precision || 0} déc.</span></span>`;
    box.appendChild(row);
  });
}
function fillCopyFromSelect() {
  const sel = document.getElementById('sCopyFrom'); sel.innerHTML = '<option value="">— vierge —</option>';
  scenarios.forEach((s) => { const o = document.createElement('option'); o.value = s.id; o.textContent = `${s.name} (${metricLabel(s.metric)})`; sel.appendChild(o); });
}

function addPhaseRow(label = '', days = '', freqMinutes = '', gs = '', ge = '') {
  const wrap = document.getElementById('phaseRows');
  const row = document.createElement('div'); row.className = 'phase-row';
  const f = freqMinutes === '' ? { d: '', h: '', m: '' } : splitMinutes(freqMinutes);
  row.innerHTML = `
    <button class="rm" title="Supprimer" type="button">×</button>
    <div class="phase-fields">
      <label class="f-label">Libellé<input class="p-label" type="text" value="${escapeAttr(label)}" placeholder="ex. Phase aiguë"></label>
      <label class="f-days">Durée (jours)<input class="p-days" type="number" min="1" value="${days}"></label>
      <div class="f-freq"><span class="p-freq-title">Fréquence (toutes les…)</span>
        <div class="p-freq-group">
          <label>jours<input class="p-fd" type="number" min="0" value="${f.d}" placeholder="0"></label>
          <label>heures<input class="p-fh" type="number" min="0" max="23" value="${f.h}" placeholder="0"></label>
          <label>min<input class="p-fm" type="number" min="0" max="59" value="${f.m}" placeholder="0"></label>
        </div>
      </div>
      <div class="f-seuil"><span class="p-freq-title">Seuil d'alerte (0–10)</span>
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
  const err = document.getElementById('scenarioFormError'); err.hidden = true;
  const phases = []; let partial = false;
  [...document.querySelectorAll('#phaseRows .phase-row')].forEach((r) => {
    const label = r.querySelector('.p-label').value.trim();
    const days = Number(r.querySelector('.p-days').value);
    const fm = (Number(r.querySelector('.p-fd').value) || 0) * 1440 + (Number(r.querySelector('.p-fh').value) || 0) * 60 + (Number(r.querySelector('.p-fm').value) || 0);
    const gsRaw = r.querySelector('.p-gs').value, geRaw = r.querySelector('.p-ge').value;
    if (!label && !days && !fm && gsRaw === '' && geRaw === '') return;
    if (!label || !days || !fm) { partial = true; return; }
    if ((gsRaw === '') !== (geRaw === '')) { partial = true; return; }
    phases.push({ label, days, frequencyMinutes: fm, gabaritStart: gsRaw === '' ? null : Number(gsRaw), gabaritEnd: geRaw === '' ? null : Number(geRaw) });
  });
  if (partial) { err.textContent = 'Phase incomplète : libellé, durée et fréquence requis ; seuils par paire ou vides.'; err.hidden = false; return; }

  const offset = (Number(document.getElementById('sOffD').value) || 0) * 1440 + (Number(document.getElementById('sOffH').value) || 0) * 60 + (Number(document.getElementById('sOffM').value) || 0);
  const payload = {
    name: document.getElementById('sName').value.trim(),
    description: document.getElementById('sDesc').value.trim(),
    metric: document.getElementById('sMetric').value,
    precision: Number(document.getElementById('sPrecision').value),
    startOffsetMinutes: offset,
    phases,
  };
  if (!payload.name) { err.textContent = 'Le nom du scénario est obligatoire.'; err.hidden = false; return; }
  try {
    if (editingScenarioId) await api(`/scenarios/${editingScenarioId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    else await api('/scenarios', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    await refresh(); newScenario();
  } catch (e) { err.textContent = e.message; err.hidden = false; }
}

function populateScenarioForm(s) {
  document.getElementById('sName').value = s.name || '';
  document.getElementById('sDesc').value = s.description || '';
  document.getElementById('sMetric').value = s.metric || 'pain';
  document.getElementById('sPrecision').value = String(s.precision || 0);
  const off = splitMinutes(s.startOffsetMinutes || 0);
  document.getElementById('sOffD').value = off.d; document.getElementById('sOffH').value = off.h; document.getElementById('sOffM').value = off.m;
  document.getElementById('phaseRows').innerHTML = '';
  (s.phases || []).forEach((p) => addPhaseRow(p.label, p.days, p.frequencyMinutes, p.gabaritStart == null ? '' : p.gabaritStart, p.gabaritEnd == null ? '' : p.gabaritEnd));
  if (!s.phases || !s.phases.length) addPhaseRow();
}
function newScenario() {
  editingScenarioId = null;
  document.getElementById('scenarioFormTitle').textContent = 'Nouveau scénario';
  document.getElementById('saveScenario').textContent = 'Créer le scénario';
  document.getElementById('duplicateScenario').hidden = true;
  document.getElementById('sCopyFrom').value = '';
  document.getElementById('scenarioFormError').hidden = true;
  populateScenarioForm({ metric: 'pain', precision: 0, phases: [] });
  renderScenarioList();
}
function editScenario(id) {
  const s = scenarios.find((x) => x.id === id); if (!s) return;
  editingScenarioId = id;
  document.getElementById('scenarioFormTitle').textContent = 'Modifier le scénario';
  document.getElementById('saveScenario').textContent = 'Enregistrer les modifications';
  document.getElementById('duplicateScenario').hidden = false;
  document.getElementById('scenarioFormError').hidden = true;
  populateScenarioForm(s); renderScenarioList();
}
function copyFromScenario() {
  const id = document.getElementById('sCopyFrom').value; if (!id) return;
  const s = scenarios.find((x) => x.id === id); if (!s) return;
  editingScenarioId = null;
  document.getElementById('scenarioFormTitle').textContent = 'Nouveau scénario';
  document.getElementById('saveScenario').textContent = 'Créer le scénario';
  document.getElementById('duplicateScenario').hidden = true;
  populateScenarioForm({ ...s, name: `${s.name} (copie)` }); renderScenarioList();
}
function duplicateScenario() {
  editingScenarioId = null;
  document.getElementById('scenarioFormTitle').textContent = 'Nouveau scénario';
  document.getElementById('saveScenario').textContent = 'Créer le scénario';
  document.getElementById('duplicateScenario').hidden = true;
  document.getElementById('sName').value = `${document.getElementById('sName').value.trim()} (copie)`;
  renderScenarioList();
}

// --- Graphiques (fenêtre de temps + ascenseur proportionnel) --------------

const CHART = { W: 700, H: 300, padL: 40, padR: 16, padT: 14, padB: 54 };
const DAY = 24 * 60 * 60 * 1000;
let currentSeries = null;
let domStart = 0, domEnd = 0, viewStart = 0, viewEnd = 0, barSync = false;

const domSpan = () => Math.max(1, domEnd - domStart);
const viewSpan = () => Math.max(1, viewEnd - viewStart);
const minSpan = () => Math.max(6 * 3600 * 1000, domSpan() / 60);
function clampView() {
  const span = Math.min(viewEnd - viewStart, domSpan());
  viewStart = Math.max(domStart, Math.min(viewStart, domEnd - span));
  viewEnd = viewStart + span;
}

function setSeries(s) {
  currentSeries = s;
  domStart = new Date(s.timeline.start).getTime();
  domEnd = new Date(s.timeline.end).getTime();
  viewStart = domStart; viewEnd = domEnd;
  renderCharts(); updateScrollbar();
}
function chartHelpers() {
  const { W, H, padL, padR, padT, padB } = CHART;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const y = (v) => padT + plotH - (Math.max(0, Math.min(10, v)) / 10) * plotH;
  const vs = viewStart, span = viewSpan();
  const x = (t) => padL + ((new Date(t).getTime() - vs) / span) * plotW;
  return { W, H, padL, padR, padT, padB, plotW, plotH, x, y };
}
function yGrid(h) {
  const p = [];
  for (let v = 0; v <= 10; v += 2) { const yy = h.y(v); p.push(`<line x1="${h.padL}" y1="${yy}" x2="${h.W - h.padR}" y2="${yy}" stroke="#eef2f4"/>`); p.push(`<text x="${h.padL - 8}" y="${yy + 4}" text-anchor="end" font-size="11" fill="#5B6B7A">${v}</text>`); }
  return p;
}
function dayAxis(h) {
  const p = []; const day0 = new Date(viewStart); day0.setHours(0, 0, 0, 0);
  const spacing = h.plotW / Math.max(1, viewSpan() / DAY);
  let mode = 'day', everyN = 1;
  if (spacing < 38) { mode = 'week'; if (spacing * 7 < 38) everyN = Math.ceil(38 / (spacing * 7)); }
  const baseY = h.padT + h.plotH, labelY = baseY + 16;
  let d = new Date(day0), mIdx = 0;
  while (d.getTime() <= viewEnd) {
    let show = false;
    if (mode === 'day') show = true; else if (d.getDay() === 1) { show = (mIdx % everyN === 0); mIdx += 1; }
    if (show && d.getTime() >= viewStart) {
      const xx = h.x(d);
      p.push(`<line x1="${xx.toFixed(1)}" y1="${h.padT}" x2="${xx.toFixed(1)}" y2="${baseY}" stroke="#f1f5f6"/>`);
      p.push(`<text x="${xx.toFixed(1)}" y="${labelY}" text-anchor="middle" font-size="10" fill="#5B6B7A">${d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })}</text>`);
    }
    d.setDate(d.getDate() + 1);
  }
  return p;
}
function svgOpen(label, clip) {
  const { W, H, padL, padR, padT, padB } = CHART;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}">`
    + `<defs><clipPath id="${clip}"><rect x="${padL}" y="${padT}" width="${W - padL - padR}" height="${H - padT - padB}"/></clipPath></defs>`;
}
function fmtDate(t) { return new Date(t).toLocaleString('fr-FR'); }
function drawDataPoint(parts, x, y, kind, alert, color, title) {
  const xs = x.toFixed(1), ys = y.toFixed(1);
  if (kind === 'spontaneous') parts.push(`<circle cx="${xs}" cy="${ys}" r="5" fill="#fff" stroke="${alert ? '#C0392B' : color}" stroke-width="2.5"><title>${title}</title></circle>`);
  else parts.push(`<circle cx="${xs}" cy="${ys}" r="${alert ? 6 : 4.5}" fill="${alert ? '#C0392B' : color}" stroke="#fff" stroke-width="1.5"><title>${title}</title></circle>`);
}
function drawMissedPoint(parts, x, y, title) {
  const r = 4, xs = x.toFixed(1), ys = y.toFixed(1);
  parts.push(`<path d="M${(x - r).toFixed(1)} ${(y - r).toFixed(1)} L${(x + r).toFixed(1)} ${(y + r).toFixed(1)} M${(x - r).toFixed(1)} ${(y + r).toFixed(1)} L${(x + r).toFixed(1)} ${(y - r).toFixed(1)}" stroke="#9AA8B4" stroke-width="2" stroke-linecap="round"><title>${title}</title></path>`);
}

function drawPainChart(c, s) {
  const h = chartHelpers(); const pts = s.pain.points, env = s.pain.envelope || [], missed = s.pain.missed || [];
  const prec = (s.pain.scenario && s.pain.scenario.precision) || 0;
  const parts = [svgOpen('Courbe de douleur', 'clipPain'), ...dayAxis(h), ...yGrid(h), '<g clip-path="url(#clipPain)">'];
  if (env.length) {
    const top = env.map((e, i) => `${i ? 'L' : 'M'}${h.x(e.t).toFixed(1)} ${h.y(e.ceiling).toFixed(1)}`).join(' ');
    parts.push(`<path d="${top} L${h.x(env[env.length - 1].t).toFixed(1)} ${h.y(0).toFixed(1)} L${h.x(env[0].t).toFixed(1)} ${h.y(0).toFixed(1)} Z" fill="rgba(14,124,123,.12)"/>`);
    parts.push(`<path d="${top}" fill="none" stroke="rgba(14,124,123,.55)" stroke-width="1.5" stroke-dasharray="5 3"/>`);
  }
  if (pts.length > 1) parts.push(`<path d="${pts.map((q, i) => `${i ? 'L' : 'M'}${h.x(q.t).toFixed(1)} ${h.y(q.value).toFixed(1)}`).join(' ')}" fill="none" stroke="#0E7C7B" stroke-width="2.5" stroke-linejoin="round"/>`);
  missed.forEach((m) => drawMissedPoint(parts, h.x(m.t), h.y(m.value), `Créneau manqué — valeur interpolée ≈ ${Number(m.value).toFixed(prec)}/10 — ${fmtDate(m.t)}`));
  pts.forEach((q) => drawDataPoint(parts, h.x(q.t), h.y(q.value), q.kind, q.outOfBounds, '#0E7C7B', `${Number(q.value).toFixed(prec)}/10${q.kind === 'spontaneous' ? ' · saisie spontanée' : ''}${q.outOfBounds ? ' · ALERTE' : ''} — ${fmtDate(q.t)}`));
  parts.push('</g>'); if (!pts.length) parts.push(emptyMsg(h, 'Aucune mesure de douleur.')); parts.push('</svg>');
  c.innerHTML = parts.join('');
}
function drawSleepChart(c, s) {
  const h = chartHelpers(); const pts = s.sleep.points, missed = s.sleep.missed || [];
  const parts = [svgOpen('Qualité du sommeil', 'clipSleep'), ...dayAxis(h), ...yGrid(h), '<g clip-path="url(#clipSleep)">'];
  if (pts.length > 1) parts.push(`<path d="${pts.map((q, i) => `${i ? 'L' : 'M'}${h.x(q.t).toFixed(1)} ${h.y(q.value).toFixed(1)}`).join(' ')}" fill="none" stroke="#2e7d6b" stroke-width="2.5" stroke-linejoin="round"/>`);
  missed.forEach((m) => drawMissedPoint(parts, h.x(m.t), h.y(m.value), `Créneau manqué — valeur interpolée ≈ ${Number(m.value).toFixed(0)}/10 — ${fmtDate(m.t)}`));
  pts.forEach((q) => drawDataPoint(parts, h.x(q.t), h.y(q.value), q.kind, false, '#2e7d6b', `Sommeil ${q.value}/10${q.kind === 'spontaneous' ? ' · saisie spontanée' : ''} — ${fmtDate(q.t)}`));
  parts.push('</g>'); if (!pts.length) parts.push(emptyMsg(h, 'Aucune donnée de sommeil.')); parts.push('</svg>');
  c.innerHTML = parts.join('');
}
function emptyMsg(h, t) { return `<text x="${h.W / 2}" y="${h.H / 2}" text-anchor="middle" font-size="13" fill="#5B6B7A">${t}</text>`; }

function renderCharts() {
  if (!currentSeries) return;
  drawPainChart(document.getElementById('chart'), currentSeries);
  drawSleepChart(document.getElementById('sleepChart'), currentSeries);
}
function updateScrollbar() {
  const bar = document.getElementById('chartScroll'), inner = document.getElementById('chartScrollInner');
  inner.style.width = `${(domSpan() / viewSpan()) * 100}%`;
  const range = domSpan() - viewSpan();
  const frac = range > 0 ? (viewStart - domStart) / range : 0;
  barSync = true; bar.scrollLeft = frac * (bar.scrollWidth - bar.clientWidth); barSync = false;
}
function onScrollbarScroll() {
  if (barSync) return;
  const bar = document.getElementById('chartScroll');
  const span = viewEnd - viewStart;                 // largeur constante : on déplace, on ne zoome pas
  const scrollable = bar.scrollWidth - bar.clientWidth;
  const frac = scrollable > 0 ? bar.scrollLeft / scrollable : 0;
  viewStart = domStart + frac * (domSpan() - span);
  viewEnd = viewStart + span;
  clampView();
  renderCharts();
}
function zoomTo(factor, anchorTime) {
  const span = viewSpan();
  const newSpan = Math.max(minSpan(), Math.min(domSpan(), span / factor));
  if (newSpan === span) return;
  const frac = Math.max(0, Math.min(1, (anchorTime - viewStart) / span));
  viewStart = anchorTime - frac * newSpan; viewEnd = viewStart + newSpan; clampView();
  renderCharts(); updateScrollbar();
}
function onChartWheel(e) {
  if (!currentSeries) return; e.preventDefault();
  const rect = e.currentTarget.getBoundingClientRect();
  const fracPx = rect.width ? (e.clientX - rect.left) / rect.width : 0.5;
  const plotFrac = Math.max(0, Math.min(1, (fracPx * CHART.W - CHART.padL) / (CHART.W - CHART.padL - CHART.padR)));
  zoomTo(e.deltaY < 0 ? 1.25 : 1 / 1.25, viewStart + plotFrac * viewSpan());
}
function zoomButton(f) { zoomTo(f, viewStart + viewSpan() / 2); }
function resetZoom() { viewStart = domStart; viewEnd = domEnd; renderCharts(); updateScrollbar(); }

// Glisser la courbe à la souris (ou au doigt) pour déplacer la fenêtre.
let dragging = false, dragStartX = 0, dragStartView = 0;
function onChartPointerDown(e) {
  if (!currentSeries || viewSpan() >= domSpan()) return; // rien à déplacer si non zoomé
  dragging = true; dragStartX = e.clientX; dragStartView = viewStart;
  if (e.currentTarget.setPointerCapture) try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.currentTarget.classList.add('grabbing');
  e.preventDefault();
}
function onChartPointerMove(e) {
  if (!dragging) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const plotW = CHART.W - CHART.padL - CHART.padR;
  const span = viewEnd - viewStart;
  const tPerPx = rect.width ? (span * CHART.W) / (plotW * rect.width) : 0;
  viewStart = dragStartView - (e.clientX - dragStartX) * tPerPx;
  viewEnd = viewStart + span;
  clampView();
  renderCharts(); updateScrollbar();
}
function onChartPointerUp(e) { dragging = false; if (e.currentTarget.classList) e.currentTarget.classList.remove('grabbing'); }

// --- Onglets & init -------------------------------------------------------

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  ['interventions', 'patients', 'scenarios'].forEach((n) => { document.getElementById(`tab-${n}`).hidden = n !== name; });
  if (name === 'interventions' && currentSeries) { renderCharts(); updateScrollbar(); }
}

function init() {
  migratePrivate();
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // Interventions
  document.getElementById('itvSearch').addEventListener('input', renderInterventionList);
  document.getElementById('itvAlertOnly').addEventListener('change', renderInterventionList);
  document.getElementById('newInterventionBtn').addEventListener('click', () => showInterventionForm(null));
  document.getElementById('saveIntervention').addEventListener('click', saveIntervention);
  document.getElementById('cancelIntervention').addEventListener('click', () => { document.getElementById('interventionForm').hidden = true; document.getElementById('emptyItv').hidden = false; });
  document.getElementById('editFiche').addEventListener('click', () => openFicheModal(ficheTarget));

  // Patients
  document.getElementById('patSearch').addEventListener('input', renderPatientList);
  document.getElementById('newPatientBtn').addEventListener('click', showPatientForm);
  document.getElementById('savePatient').addEventListener('click', savePatient);
  document.getElementById('cancelPatient').addEventListener('click', () => { document.getElementById('patientForm').hidden = true; document.getElementById('emptyPat').hidden = false; });
  document.getElementById('editFiche2').addEventListener('click', () => openFicheModal(activePatientId));
  document.getElementById('newItvForPatient').addEventListener('click', () => { switchTab('interventions'); showInterventionForm(activePatientId); });

  // Fiche modale
  document.getElementById('ficheSave').addEventListener('click', saveFiche);
  document.getElementById('ficheCancel').addEventListener('click', closeFicheModal);

  // Scénarios
  document.getElementById('addPhase').addEventListener('click', () => addPhaseRow());
  document.getElementById('saveScenario').addEventListener('click', saveScenario);
  document.getElementById('newScenarioBtn').addEventListener('click', newScenario);
  document.getElementById('duplicateScenario').addEventListener('click', duplicateScenario);
  document.getElementById('sCopyFrom').addEventListener('change', copyFromScenario);
  addPhaseRow();

  // Graphiques
  ['chart', 'sleepChart'].forEach((id) => {
    const el = document.getElementById(id);
    el.addEventListener('wheel', onChartWheel, { passive: false });
    el.addEventListener('pointerdown', onChartPointerDown);
    el.addEventListener('pointermove', onChartPointerMove);
    el.addEventListener('pointerup', onChartPointerUp);
    el.addEventListener('pointercancel', onChartPointerUp);
    el.addEventListener('pointerleave', onChartPointerUp);
  });
  document.getElementById('zoomIn').addEventListener('click', () => zoomButton(1.4));
  document.getElementById('zoomOut').addEventListener('click', () => zoomButton(1 / 1.4));
  document.getElementById('zoomReset').addEventListener('click', resetZoom);
  document.getElementById('chartScroll').addEventListener('scroll', onScrollbarScroll, { passive: true });

  refresh().catch((e) => { document.getElementById('emptyItv').innerHTML = `<p class="error">Serveur injoignable : ${escapeHtml(e.message)}</p>`; });
}
init();
