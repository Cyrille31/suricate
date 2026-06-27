'use strict';

/**
 * Couche d'accès aux données du MVP-0.
 *
 * Volontairement minimaliste : persistance dans un simple fichier JSON,
 * sans dépendance externe, pour que le projet tourne immédiatement après
 * un `git clone` (aucun build natif, aucune base à installer).
 *
 * IMPORTANT : tout l'accès aux données passe par ce module. Pour la mise en
 * production, on remplacera l'implémentation interne par SQLite puis par une
 * base PostgreSQL hébergée chez un Hébergeur de Données de Santé (HDS), sans
 * toucher au reste de l'application (serveur, API).
 *
 * Choix de confidentialité (cf. spécifications) :
 *   - Le serveur ne stocke JAMAIS le nom du patient.
 *   - Seul le pseudo est centralisé. La correspondance pseudo <=> nom reste
 *     côté médecin (stockée localement dans le navigateur du tableau de bord).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function nowISO() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function emptyDb() {
  return { scenarios: [], patients: [], measurements: [] };
}

let db = null;

function load() {
  if (db) return db;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (err) {
      throw new Error(`Fichier de données illisible (${DB_FILE}) : ${err.message}`);
    }
  } else {
    db = emptyDb();
    persist();
  }
  // Migration douce si le fichier est partiel
  for (const k of Object.keys(emptyDb())) if (!db[k]) db[k] = [];
  return db;
}

let writeTimer = null;
function persist() {
  // Écriture atomique (fichier temporaire puis renommage) pour éviter une
  // corruption en cas d'interruption pendant l'écriture.
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function save() {
  // Débounce léger : regroupe les écritures rapprochées.
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    persist();
  }, 50);
}

// ---------------------------------------------------------------------------
// Scénarios
// ---------------------------------------------------------------------------

function listScenarios() {
  return load().scenarios;
}

function getScenario(id) {
  return load().scenarios.find((s) => s.id === id) || null;
}

/**
 * scenario = {
 *   name, description,
 *   phases: [{ label, days, frequencyMinutes }],
 *   gabarit: { min: number, max: number }   // enveloppe de douleur attendue
 *   questions: [...]                         // (MVP-1, ignoré pour l'instant)
 * }
 */
function createScenario(input) {
  const scenario = {
    id: newId('scn'),
    name: String(input.name || 'Scénario sans nom'),
    description: String(input.description || ''),
    phases: Array.isArray(input.phases) ? input.phases : [],
    gabarit: input.gabarit && typeof input.gabarit === 'object'
      ? { min: Number(input.gabarit.min ?? 0), max: Number(input.gabarit.max ?? 10) }
      : { min: 0, max: 10 },
    questions: Array.isArray(input.questions) ? input.questions : [],
    createdAt: nowISO(),
  };
  load().scenarios.push(scenario);
  save();
  return scenario;
}

// ---------------------------------------------------------------------------
// Patients (pseudonymisés)
// ---------------------------------------------------------------------------

function listPatients() {
  return load().patients;
}

function getPatient(id) {
  return load().patients.find((p) => p.id === id) || null;
}

function getPatientByPseudo(pseudo) {
  return load().patients.find((p) => p.pseudo === pseudo) || null;
}

function createPatient(input) {
  const pseudo = String(input.pseudo || '').trim();
  if (!pseudo) throw new Error('Le pseudo est obligatoire.');
  if (getPatientByPseudo(pseudo)) throw new Error('Ce pseudo existe déjà.');
  const scenario = getScenario(input.scenarioId);
  if (!scenario) throw new Error('Scénario introuvable.');

  const patient = {
    id: newId('pat'),
    pseudo,                       // jamais le nom réel
    scenarioId: scenario.id,
    startDate: input.startDate || nowISO(),
    // Données accessibles aux chercheurs (anonymes) :
    operation: String(input.operation || ''),
    ageRange: String(input.ageRange || ''),
    sex: String(input.sex || ''),
    createdAt: nowISO(),
  };
  load().patients.push(patient);
  save();
  return patient;
}

// ---------------------------------------------------------------------------
// Mesures (douleur 0-10 pour le MVP-0)
// ---------------------------------------------------------------------------

function listMeasurements(patientId) {
  return load().measurements
    .filter((m) => m.patientId === patientId)
    .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
}

/**
 * Ajoute une mesure de façon IDEMPOTENTE.
 * Le client fournit un `clientId` (uuid local) : si une mesure avec ce même
 * clientId existe déjà, on ne la duplique pas. C'est ce qui rend la
 * synchronisation hors-ligne sûre (un renvoi en double n'a aucun effet).
 */
function addMeasurement(patientId, input) {
  const patient = getPatient(patientId);
  if (!patient) throw new Error('Patient introuvable.');

  const clientId = String(input.clientId || newId('m'));
  const existing = load().measurements.find(
    (m) => m.patientId === patientId && m.clientId === clientId
  );
  if (existing) return existing; // déjà reçue : on renvoie l'existante

  const value = Number(input.value);
  if (!Number.isFinite(value) || value < 0 || value > 10) {
    throw new Error('La valeur de douleur doit être un nombre entre 0 et 10.');
  }

  const measurement = {
    id: newId('msr'),
    patientId,
    clientId,
    type: 'pain',
    value,
    recordedAt: input.recordedAt || nowISO(), // moment ressenti côté patient
    receivedAt: nowISO(),                      // moment de réception serveur
  };
  load().measurements.push(measurement);
  save();
  return measurement;
}

module.exports = {
  listScenarios, getScenario, createScenario,
  listPatients, getPatient, getPatientByPseudo, createPatient,
  listMeasurements, addMeasurement,
  _internal: { load, persist, DB_FILE, emptyDb },
};
