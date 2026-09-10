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
    CREATE TABLE IF NOT EXISTS interventions (
      id SERIAL PRIMARY KEY,
      chantier_id INTEGER NOT NULL REFERENCES chantiers(id) ON DELETE CASCADE,
      technicien_initiales TEXT NOT NULL,
      commentaire TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      password_hash TEXT NOT NULL,
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);

  const { rows } = await pool.query("SELECT id FROM admin_config WHERE id = 1");
  if (rows.length === 0) {
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD || "HDPI2026";
    const hash = await bcrypt.hash(initialPassword, 10);
    await pool.query("INSERT INTO admin_config (id, password_hash) VALUES (1, $1)", [hash]);
    console.log("Mot de passe admin initial défini (voir ADMIN_INITIAL_PASSWORD si personnalisé).");
  }
}

module.exports = { pool, migrate };
