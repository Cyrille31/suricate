'use strict';

/**
 * Couche d'accès aux données (MVP — persistance fichier JSON, sans dépendance).
 *
 * Modèle (v0.7) :
 *   - patients      : la PERSONNE. Données de recherche stables (sexe, tranche
 *                     d'âge) + pseudo. L'identité réelle (nom, contacts) n'est
 *                     PAS ici : elle reste sur le poste du médecin.
 *   - interventions : un ÉPISODE opératoire d'un patient (opération, date de
 *                     début, scénarios). Un patient peut en avoir plusieurs.
 *   - scenarios     : modèle de suivi (métrique, précision, décalage, phases).
 *   - measurements  : mesures rattachées à une INTERVENTION.
 *
 * Tout passe par ce module -> migration future vers SQLite/PostgreSQL (HDS) aisée.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const nowISO = () => new Date().toISOString();
const newId = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const emptyDb = () => ({ patients: [], interventions: [], scenarios: [], measurements: [] });

// Persistance : fichier local par défaut ; base cloud (Upstash/Vercel KV, API
// REST) si les variables d'environnement sont présentes. Aucune dépendance npm
// (on utilise fetch, natif depuis Node 18). La base entière tient dans une clé.
const CLOUD_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const CLOUD_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const CLOUD = Boolean(CLOUD_URL && CLOUD_TOKEN);
const CLOUD_KEY = process.env.SURICATE_DB_KEY || 'suricate:db:v1';

let db = null;

function fillDefaults() { for (const k of Object.keys(emptyDb())) if (!db[k]) db[k] = []; }
function readFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { throw new Error(`Fichier de données illisible : ${e.message}`); } }
  return emptyDb();
}
function persistFile() {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
async function cloudCmd(cmd) {
  const res = await fetch(CLOUD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error(`Base cloud : HTTP ${res.status}`);
  return res.json();
}

// Charge la base en mémoire (à appeler au démarrage du serveur, surtout en cloud).
async function init() {
  if (db) return db;
  if (CLOUD) { const out = await cloudCmd(['GET', CLOUD_KEY]); db = out && out.result ? JSON.parse(out.result) : emptyDb(); }
  else { db = readFile(); if (!fs.existsSync(DB_FILE)) persistFile(); }
  fillDefaults();
  return db;
}
function load() {
  if (db) return db;
  if (CLOUD) throw new Error('Base cloud non initialisée : appelez init() au démarrage.');
  db = readFile(); fillDefaults();
  if (!fs.existsSync(DB_FILE)) persistFile();
  return db;
}
let writeTimer = null;
function save() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (CLOUD) flush().catch((e) => console.error('Sauvegarde cloud échouée :', e.message));
    else persistFile();
  }, CLOUD ? 300 : 50);
}
async function flush() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!db) return;
  if (CLOUD) await cloudCmd(['SET', CLOUD_KEY, JSON.stringify(db)]);
  else persistFile();
}
async function reset() {
  await init();
  db = emptyDb();
  if (CLOUD) await flush();
  else { try { fs.rmSync(DB_FILE, { force: true }); } catch { /* ignore */ } persistFile(); }
}

// --- Scénarios ------------------------------------------------------------

function listScenarios() { return load().scenarios; }
function getScenario(id) { return load().scenarios.find((s) => s.id === id) || null; }

function normGab(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : null;
}
function normalizePhase(p) {
  return {
    label: String((p && p.label) || ''),
    days: Number((p && p.days) || 0),
    frequencyMinutes: Number((p && p.frequencyMinutes) || 0),
    gabaritStart: normGab(p && p.gabaritStart),
    gabaritEnd: normGab(p && p.gabaritEnd),
  };
}
const normMetric = (m) => (m === 'sleep' ? 'sleep' : 'pain');
const normPrecision = (p) => ([0, 1, 2].includes(Number(p)) ? Number(p) : 0);
const normOffset = (m) => { const n = Number(m); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };

function createScenario(input) {
  const s = {
    id: newId('scn'),
    name: String(input.name || 'Scénario sans nom'),
    description: String(input.description || ''),
    metric: normMetric(input.metric),
    precision: normPrecision(input.precision),
    startOffsetMinutes: normOffset(input.startOffsetMinutes),
    phases: (Array.isArray(input.phases) ? input.phases : []).map(normalizePhase),
    createdAt: nowISO(),
  };
  load().scenarios.push(s);
  save();
  return s;
}
function updateScenario(id, input) {
  const s = getScenario(id);
  if (!s) throw new Error('Scénario introuvable.');
  if (input.name != null) s.name = String(input.name);
  if (input.description != null) s.description = String(input.description);
  if (input.metric != null) s.metric = normMetric(input.metric);
  if (input.precision != null) s.precision = normPrecision(input.precision);
  if (input.startOffsetMinutes != null) s.startOffsetMinutes = normOffset(input.startOffsetMinutes);
  if (Array.isArray(input.phases)) s.phases = input.phases.map(normalizePhase);
  s.updatedAt = nowISO();
  save();
  return s;
}

// --- Patients (personnes) -------------------------------------------------

function listPatients() { return load().patients; }
function getPatient(id) { return load().patients.find((p) => p.id === id) || null; }
function getPatientByPseudo(pseudo) { return load().patients.find((p) => p.pseudo === pseudo) || null; }

function nextPersonPseudo() {
  let n = load().patients.length + 1;
  while (getPatientByPseudo(`P-${String(n).padStart(3, '0')}`)) n += 1;
  return `P-${String(n).padStart(3, '0')}`;
}

function createPatient(input) {
  const pseudo = String(input.pseudo || '').trim() || nextPersonPseudo();
  if (getPatientByPseudo(pseudo)) throw new Error('Ce pseudo patient existe déjà.');
  const patient = {
    id: newId('pat'),
    pseudo,
    sex: String(input.sex || ''),
    ageRange: String(input.ageRange || ''),
    createdAt: nowISO(),
  };
  load().patients.push(patient);
  save();
  return patient;
}

// --- Interventions (épisodes) ---------------------------------------------

function listInterventions() { return load().interventions; }
function getIntervention(id) { return load().interventions.find((i) => i.id === id) || null; }
function getInterventionByPseudo(pseudo) { return load().interventions.find((i) => i.pseudo === pseudo) || null; }
function listInterventionsByPatient(patientId) { return load().interventions.filter((i) => i.patientId === patientId); }

function createIntervention(input) {
  const pseudo = String(input.pseudo || '').trim();
  if (!pseudo) throw new Error('Le pseudo de l\'intervention est obligatoire.');
  if (getInterventionByPseudo(pseudo)) throw new Error('Ce pseudo d\'intervention existe déjà.');
  if (!getPatient(input.patientId)) throw new Error('Patient introuvable.');
  const ids = Array.isArray(input.scenarioIds) ? input.scenarioIds : [];
  if (!ids.length) throw new Error('Au moins un scénario est requis.');
  for (const sid of ids) if (!getScenario(sid)) throw new Error('Scénario introuvable.');

  const intervention = {
    id: newId('itv'),
    patientId: input.patientId,
    pseudo,
    operation: String(input.operation || ''),
    startDate: input.startDate || nowISO(),
    scenarioIds: ids,
    createdAt: nowISO(),
  };
  load().interventions.push(intervention);
  save();
  return intervention;
}

function getScenarioIds(intervention) {
  return (intervention.scenarioIds && intervention.scenarioIds.length) ? intervention.scenarioIds : [];
}

// --- Mesures (rattachées à une intervention) ------------------------------

function listMeasurements(interventionId) {
  return load().measurements
    .filter((m) => m.interventionId === interventionId)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

function addMeasurement(interventionId, input) {
  if (!getIntervention(interventionId)) throw new Error('Intervention introuvable.');
  const clientId = String(input.clientId || newId('m'));
  const existing = load().measurements.find((m) => m.interventionId === interventionId && m.clientId === clientId);
  if (existing) return existing;

  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error('La valeur doit être un nombre entre 0 et 10.');
  const type = input.type === 'sleep' ? 'sleep' : 'pain';

  const measurement = {
    id: newId('msr'),
    interventionId,
    clientId,
    type,
    value,
    source: input.source === 'spontaneous' ? 'spontaneous' : (input.source === 'scheduled' ? 'scheduled' : null),
    recordedAt: input.recordedAt || nowISO(),
    receivedAt: nowISO(),
  };
  load().measurements.push(measurement);
  save();
  return measurement;
}

module.exports = {
  init, flush, reset,
  listScenarios, getScenario, createScenario, updateScenario,
  listPatients, getPatient, getPatientByPseudo, createPatient,
  listInterventions, getIntervention, getInterventionByPseudo, listInterventionsByPatient,
  createIntervention, getScenarioIds,
  listMeasurements, addMeasurement,
  _internal: { load, flush, DB_FILE, emptyDb, CLOUD },
};
