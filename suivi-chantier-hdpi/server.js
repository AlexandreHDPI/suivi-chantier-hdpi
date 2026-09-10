const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const { pool, migrate } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const COOKIE_NAME = "hdpi_session";
const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 jours

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// ---------- helpers ----------

function signSession() {
  return jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "90d" });
}

function requireAdmin(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "not_authenticated" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin") throw new Error("bad role");
    next();
  } catch (e) {
    return res.status(401).json({ error: "not_authenticated" });
  }
}

function cleanInitiales(v) {
  return String(v || "").trim().toUpperCase().slice(0, 6);
}

// ---------- public read endpoints ----------

app.get("/api/chantiers", async (req, res) => {
  try {
    const chantiers = await pool.query(
      "SELECT id, nom, adresse, created_at FROM chantiers ORDER BY created_at ASC"
    );
    const interventions = await pool.query(
      "SELECT id, chantier_id, technicien_initiales, commentaire, created_at FROM interventions ORDER BY created_at ASC"
    );
    const byChantier = {};
    for (const iv of interventions.rows) {
      if (!byChantier[iv.chantier_id]) byChantier[iv.chantier_id] = [];
      byChantier[iv.chantier_id].push({
        id: iv.id,
        initiales: iv.technicien_initiales,
        commentaire: iv.commentaire,
        date: iv.created_at,
      });
    }
    const result = chantiers.rows.map((c) => ({
      id: c.id,
      nom: c.nom,
      adresse: c.adresse,
      createdAt: c.created_at,
      interventions: byChantier[c.id] || [],
    }));
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/techniciens", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, initiales, nom FROM techniciens ORDER BY initiales ASC"
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/api/admin/me", (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.json({ authenticated: false });
  try {
    jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true });
  } catch (e) {
    res.json({ authenticated: false });
  }
});

// ---------- public write: mark done ----------

app.post("/api/interventions", async (req, res) => {
  try {
    const chantierId = parseInt(req.body.chantierId, 10);
    const initiales = cleanInitiales(req.body.initiales);
    const commentaire = String(req.body.commentaire || "").trim().slice(0, 2000);

    if (!chantierId || !initiales) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const tech = await pool.query(
      "SELECT initiales FROM techniciens WHERE initiales = $1",
      [initiales]
    );
    if (tech.rows.length === 0) {
      return res.status(400).json({ error: "unknown_technicien" });
    }

    const chantier = await pool.query("SELECT id FROM chantiers WHERE id = $1", [chantierId]);
    if (chantier.rows.length === 0) {
      return res.status(404).json({ error: "unknown_chantier" });
    }

    const { rows } = await pool.query(
      `INSERT INTO interventions (chantier_id, technicien_initiales, commentaire)
       VALUES ($1, $2, $3) RETURNING id, chantier_id, technicien_initiales, commentaire, created_at`,
      [chantierId, initiales, commentaire]
    );
    const iv = rows[0];
    res.status(201).json({
      id: iv.id,
      chantierId: iv.chantier_id,
      initiales: iv.technicien_initiales,
      commentaire: iv.commentaire,
      date: iv.created_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- admin auth ----------

app.post("/api/admin/login", async (req, res) => {
  try {
    const password = String(req.body.password || "");
    const { rows } = await pool.query("SELECT password_hash FROM admin_config WHERE id = 1");
    if (rows.length === 0) return res.status(500).json({ error: "server_error" });

    const ok = await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: "wrong_password" });

    const token = signSession();
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_MS,
    });
    res.json({ authenticated: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.post("/api/admin/password", requireAdmin, async (req, res) => {
  try {
    const newPassword = String(req.body.newPassword || "");
    if (newPassword.length < 4) {
      return res.status(400).json({ error: "too_short" });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE admin_config SET password_hash = $1 WHERE id = 1", [hash]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- admin: chantiers ----------

app.post("/api/admin/chantiers", requireAdmin, async (req, res) => {
  try {
    const nom = String(req.body.nom || "").trim().slice(0, 200);
    const adresse = String(req.body.adresse || "").trim().slice(0, 300);
    if (!nom) return res.status(400).json({ error: "invalid_input" });
    const { rows } = await pool.query(
      "INSERT INTO chantiers (nom, adresse) VALUES ($1, $2) RETURNING id, nom, adresse, created_at",
      [nom, adresse]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.put("/api/admin/chantiers/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const nom = String(req.body.nom || "").trim().slice(0, 200);
    const adresse = String(req.body.adresse || "").trim().slice(0, 300);
    if (!id || !nom) return res.status(400).json({ error: "invalid_input" });
    const { rows } = await pool.query(
      "UPDATE chantiers SET nom = $1, adresse = $2 WHERE id = $3 RETURNING id, nom, adresse, created_at",
      [nom, adresse, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.delete("/api/admin/chantiers/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query("DELETE FROM chantiers WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- admin: techniciens ----------

app.post("/api/admin/techniciens", requireAdmin, async (req, res) => {
  try {
    const initiales = cleanInitiales(req.body.initiales);
    const nom = String(req.body.nom || "").trim().slice(0, 120);
    if (!initiales) return res.status(400).json({ error: "invalid_input" });
    const { rows } = await pool.query(
      `INSERT INTO techniciens (initiales, nom) VALUES ($1, $2)
       ON CONFLICT (initiales) DO UPDATE SET nom = EXCLUDED.nom
       RETURNING id, initiales, nom`,
      [initiales, nom]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.delete("/api/admin/techniciens/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query("DELETE FROM techniciens WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- admin: undo an intervention ----------

app.delete("/api/admin/interventions/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query("DELETE FROM interventions WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

// ---------- boot ----------

app.get("/healthz", (req, res) => res.send("ok"));

migrate()
  .then(() => {
    app.listen(PORT, () => {
      console.log("Suivi Chantier démarré sur le port " + PORT);
    });
  })
  .catch((e) => {
    console.error("Échec de la migration :", e);
    process.exit(1);
  });
