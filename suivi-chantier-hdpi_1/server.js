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

// ---------- public: the board ----------

app.get("/api/board", async (req, res) => {
  try {
    const chantiers = await pool.query(
      "SELECT id, nom, adresse, created_at FROM chantiers ORDER BY created_at ASC"
    );
    const colonnes = await pool.query(
      "SELECT id, nom, ordre FROM colonnes ORDER BY ordre ASC, id ASC"
    );
    const cells = await pool.query(
      "SELECT id, chantier_id, colonne_id, technicien_initiales, commentaire, completed_at FROM cell_status"
    );

    res.json({
      chantiers: chantiers.rows.map((c) => ({
        id: c.id,
        nom: c.nom,
        adresse: c.adresse,
        createdAt: c.created_at,
      })),
      colonnes: colonnes.rows.map((c) => ({ id: c.id, nom: c.nom, ordre: c.ordre })),
      cells: cells.rows.map((c) => ({
        id: c.id,
        chantierId: c.chantier_id,
        colonneId: c.colonne_id,
        initiales: c.technicien_initiales,
        commentaire: c.commentaire,
        date: c.completed_at,
      })),
    });
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

app.get("/api/settings", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT full_width FROM admin_config WHERE id = 1");
    res.json({ fullWidth: rows.length ? !!rows[0].full_width : false });
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

// ---------- public write: mark a cell done ----------

app.post("/api/cells", async (req, res) => {
  try {
    const chantierId = parseInt(req.body.chantierId, 10);
    const colonneId = parseInt(req.body.colonneId, 10);
    const initiales = cleanInitiales(req.body.initiales);
    const commentaire = String(req.body.commentaire || "").trim().slice(0, 2000);

    if (!chantierId || !colonneId || !initiales) {
      return res.status(400).json({ error: "invalid_input" });
    }

    const tech = await pool.query("SELECT initiales FROM techniciens WHERE initiales = $1", [initiales]);
    if (tech.rows.length === 0) return res.status(400).json({ error: "unknown_technicien" });

    const chantier = await pool.query("SELECT id FROM chantiers WHERE id = $1", [chantierId]);
    if (chantier.rows.length === 0) return res.status(404).json({ error: "unknown_chantier" });

    const colonne = await pool.query("SELECT id FROM colonnes WHERE id = $1", [colonneId]);
    if (colonne.rows.length === 0) return res.status(404).json({ error: "unknown_colonne" });

    let result;
    try {
      result = await pool.query(
        `INSERT INTO cell_status (chantier_id, colonne_id, technicien_initiales, commentaire)
         VALUES ($1, $2, $3, $4)
         RETURNING id, chantier_id, colonne_id, technicien_initiales, commentaire, completed_at`,
        [chantierId, colonneId, initiales, commentaire]
      );
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({ error: "already_done" });
      }
      throw err;
    }

    const c = result.rows[0];
    res.status(201).json({
      id: c.id,
      chantierId: c.chantier_id,
      colonneId: c.colonne_id,
      initiales: c.technicien_initiales,
      commentaire: c.commentaire,
      date: c.completed_at,
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
      maxAge: 90 * 24 * 60 * 60 * 1000,
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
    if (newPassword.length < 4) return res.status(400).json({ error: "too_short" });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE admin_config SET password_hash = $1 WHERE id = 1", [hash]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/admin/settings", requireAdmin, async (req, res) => {
  try {
    const fullWidth = !!req.body.fullWidth;
    await pool.query("UPDATE admin_config SET full_width = $1 WHERE id = 1", [fullWidth]);
    res.json({ fullWidth });
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

// ---------- admin: colonnes (types de documents / tâches) ----------

app.post("/api/admin/colonnes", requireAdmin, async (req, res) => {
  try {
    const nom = String(req.body.nom || "").trim().slice(0, 100);
    if (!nom) return res.status(400).json({ error: "invalid_input" });
    const { rows: maxRows } = await pool.query("SELECT COALESCE(MAX(ordre), 0) AS max_ordre FROM colonnes");
    const ordre = maxRows[0].max_ordre + 1;
    const { rows } = await pool.query(
      "INSERT INTO colonnes (nom, ordre) VALUES ($1, $2) RETURNING id, nom, ordre",
      [nom, ordre]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.put("/api/admin/colonnes/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const nom = String(req.body.nom || "").trim().slice(0, 100);
    if (!id || !nom) return res.status(400).json({ error: "invalid_input" });
    const { rows } = await pool.query(
      "UPDATE colonnes SET nom = $1 WHERE id = $2 RETURNING id, nom, ordre",
      [nom, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "not_found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.delete("/api/admin/colonnes/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query("DELETE FROM colonnes WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_error" });
  }
});

app.post("/api/admin/colonnes/:id/move", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const direction = req.body.direction === "up" ? "up" : "down";

    const { rows: all } = await pool.query("SELECT id, ordre FROM colonnes ORDER BY ordre ASC, id ASC");
    const idx = all.findIndex((c) => c.id === id);
    if (idx === -1) return res.status(404).json({ error: "not_found" });

    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= all.length) return res.json({ ok: true }); // already at edge

    const a = all[idx];
    const b = all[swapIdx];
    await pool.query("UPDATE colonnes SET ordre = $1 WHERE id = $2", [b.ordre, a.id]);
    await pool.query("UPDATE colonnes SET ordre = $1 WHERE id = $2", [a.ordre, b.id]);
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

// ---------- admin: undo a cell ----------

app.delete("/api/admin/cells/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query("DELETE FROM cell_status WHERE id = $1", [id]);
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
