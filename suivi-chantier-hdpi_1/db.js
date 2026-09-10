const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error("DATABASE_URL manquant : impossible de démarrer.");
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 5,
});

const DEFAULT_COLONNES = [
  { nom: "Doc technique", type: "task" },
  { nom: "Note de calcul", type: "task" },
  { nom: "Plans", type: "task" },
  { nom: "Programmation", type: "task" },
  { nom: "PV autocontrôle", type: "task" },
  { nom: "Synoptique", type: "task" },
  { nom: "Date de réception", type: "date" },
];

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS techniciens (
      id SERIAL PRIMARY KEY,
      initiales TEXT UNIQUE NOT NULL,
      nom TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chantiers (
      id SERIAL PRIMARY KEY,
      nom TEXT NOT NULL,
      adresse TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS colonnes (
      id SERIAL PRIMARY KEY,
      nom TEXT NOT NULL,
      ordre INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cell_status (
      id SERIAL PRIMARY KEY,
      chantier_id INTEGER NOT NULL REFERENCES chantiers(id) ON DELETE CASCADE,
      colonne_id INTEGER NOT NULL REFERENCES colonnes(id) ON DELETE CASCADE,
      technicien_initiales TEXT NOT NULL,
      commentaire TEXT,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (chantier_id, colonne_id)
    );
  `);

  await pool.query(`DROP TABLE IF EXISTS interventions;`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      password_hash TEXT NOT NULL,
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);

  await pool.query(`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS full_width BOOLEAN NOT NULL DEFAULT false;`);

  await pool.query(`ALTER TABLE admin_config ADD COLUMN IF NOT EXISTS zoom_level INTEGER NOT NULL DEFAULT 100;`);

  await pool.query(`ALTER TABLE colonnes ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'task';`);

  await pool.query(`UPDATE colonnes SET type = 'date' WHERE nom = 'Date de réception' AND type <> 'date';`);

  await pool.query(`ALTER TABLE cell_status ADD COLUMN IF NOT EXISTS date_value TEXT;`);

  const { rows: colonneRows } = await pool.query("SELECT id FROM colonnes LIMIT 1");
  if (colonneRows.length === 0) {
    for (let i = 0; i < DEFAULT_COLONNES.length; i++) {
      await pool.query("INSERT INTO colonnes (nom, ordre, type) VALUES ($1, $2, $3)", [DEFAULT_COLONNES[i].nom, i + 1, DEFAULT_COLONNES[i].type]);
    }
    console.log("Colonnes par défaut créées.");
  }

  const { rows } = await pool.query("SELECT id FROM admin_config WHERE id = 1");
  if (rows.length === 0) {
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || "HDPI2026";
    const hash = await bcrypt.hash(initialPassword, 10);
    await pool.query("INSERT INTO admin_config (id, password_hash) VALUES (1, $1)", [hash]);
    console.log("Mot de passe admin initial défini (voir ADMIN_INITIAL_PASSWORD si personnalisé).");
  }
}

module.exports = { pool, migrate };
