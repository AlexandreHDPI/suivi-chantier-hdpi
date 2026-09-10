(function () {
  "use strict";

  var LS_INITIALES = "hdpi_suivi_initiales";
  var LS_THEME = "hdpi_theme";
  var LS_BG_CUSTOM = "hdpi_bg_custom";
  var LS_TUTO_SEEN = "hdpi_tuto_seen";
  var DEFAULT_PAPER_LIGHT = "#eef1f3";
  var POLL_MS = 8000;

  var state = {
    isAdmin: false,
    online: false,
    chantiers: [],
    colonnes: [],
    cellsByKey: {}, // "chantierId:colonneId" -> {id,chantierId,colonneId,initiales,commentaire,date}
    techniciens: [],
    modalOpen: false,
    activeCellCtx: null, // {chantierId, colonneId, cell|null}
    editingChantierId: null,
    settings: { fullWidth: false, zoomLevel: 100 },
  };

  function safeGetLS(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSetLS(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }

  function cellKey(chantierId, colonneId) { return chantierId + ":" + colonneId; }

  function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var dd = String(d.getDate()).padStart(2, "0");
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    return dd + "/" + mm;
  }

  function formatDateValue(dateStr) {
    if (!dateStr) return "";
    var parts = dateStr.split("-"); // "YYYY-MM-DD"
    if (parts.length !== 3) return dateStr;
    return parts[2] + "/" + parts[1] + "/" + parts[0];
  }

  function isDateColonne(col) {
    return !!(col && col.type === "date");
  }

  // ---------- reception-date urgency color ----------

  function hexToRgb(hex) {
    hex = String(hex || "").trim().replace("#", "");
    if (hex.length === 3) hex = hex.split("").map(function (c) { return c + c; }).join("");
    var num = parseInt(hex, 16) || 0;
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }
  function rgbToCss(rgb) { return "rgb(" + rgb.r + "," + rgb.g + "," + rgb.b + ")"; }
  function mixRgb(a, b, t) {
    return {
      r: Math.round(a.r + (b.r - a.r) * t),
      g: Math.round(a.g + (b.g - a.g) * t),
      b: Math.round(a.b + (b.b - a.b) * t),
    };
  }
  function readCssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Plus l'échéance approche (ou est dépassée), plus la couleur vire au rouge.
  function receptionUrgencyColors(dateStr) {
    var HORIZON_DAYS = 45;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var target = new Date(dateStr + "T00:00:00");
    var daysUntil = Math.round((target - today) / 86400000);

    var t;
    if (daysUntil >= HORIZON_DAYS) t = 0;
    else if (daysUntil <= 0) t = 1;
    else t = (HORIZON_DAYS - daysUntil) / HORIZON_DAYS;

    var doneBg = hexToRgb(readCssVar("--done-bg"));
    var doneFg = hexToRgb(readCssVar("--done"));
    var pendingBg = hexToRgb(readCssVar("--pending-bg"));
    var pendingFg = hexToRgb(readCssVar("--pending"));
    var dangerBg = hexToRgb(readCssVar("--danger-bg"));
    var dangerFg = hexToRgb(readCssVar("--danger"));

    var bg, fg;
    if (t <= 0.5) {
      var t2 = t / 0.5;
      bg = mixRgb(doneBg, pendingBg, t2);
      fg = mixRgb(doneFg, pendingFg, t2);
    } else {
      var t3 = (t - 0.5) / 0.5;
      bg = mixRgb(pendingBg, dangerBg, t3);
      fg = mixRgb(pendingFg, dangerFg, t3);
    }
    return { bg: rgbToCss(bg), fg: rgbToCss(fg), daysUntil: daysUntil };
  }

  // ---------- API ----------

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = "include";
    opts.headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
    return fetch(path, opts).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          var err = new Error(data.error || "request_failed");
          err.status = res.status;
          err.data = data;
          throw err;
        });
      }
      if (res.status === 204) return null;
      return res.json().catch(function () { return null; });
    });
  }

  function fetchBoard() {
    return api("/api/board").then(function (data) {
      state.chantiers = data.chantiers;
      state.colonnes = data.colonnes;
      state.cellsByKey = {};
      data.cells.forEach(function (c) {
        state.cellsByKey[cellKey(c.chantierId, c.colonneId)] = c;
      });
      state.online = true;
    });
  }
  function fetchTechniciens() {
    return api("/api/techniciens").then(function (data) { state.techniciens = data; });
  }
  function fetchMe() {
    return api("/api/admin/me").then(function (data) { state.isAdmin = !!(data && data.authenticated); });
  }
  function fetchSettings() {
    return api("/api/settings").then(function (data) { state.settings = data || { fullWidth: false, zoomLevel: 100 }; });
  }

  // ---------- header / status ----------

  function renderHeaderActions() {
    var el = document.getElementById("headerActions");
    el.innerHTML = "";
    if (state.isAdmin) {
      var pill = document.createElement("span");
      pill.className = "admin-pill";
      pill.textContent = "Admin";
      el.appendChild(pill);

      var lockBtn = document.createElement("button");
      lockBtn.className = "btn btn-sm";
      lockBtn.textContent = "Se déconnecter";
      lockBtn.onclick = function () {
        api("/api/admin/logout", { method: "POST" }).finally(function () {
          state.isAdmin = false;
          renderAll();
        });
      };
      el.appendChild(lockBtn);
    } else {
      var unlockBtn = document.createElement("button");
      unlockBtn.className = "btn btn-admin btn-sm";
      unlockBtn.textContent = "Mode admin";
      unlockBtn.onclick = openLoginModal;
      el.appendChild(unlockBtn);
    }
  }

  function renderStatus() {
    var dot = document.getElementById("statusDot");
    var text = document.getElementById("statusText");
    if (state.online) {
      dot.classList.remove("off");
      text.textContent = "Synchronisé";
    } else {
      dot.classList.add("off");
      text.textContent = "Connexion…";
    }
  }

  // ---------- admin panel ----------

  function renderAdminPanel() {
    var panel = document.getElementById("adminPanel");
    panel.hidden = !state.isAdmin;
    if (!state.isAdmin) return;

    renderTechList();
    renderColonneList();
    renderWidthChoiceActive();
    renderZoomControlActive();
  }

  function renderTechList() {
    var techList = document.getElementById("techList");
    techList.innerHTML = "";
    if (state.techniciens.length === 0) {
      var none = document.createElement("span");
      none.className = "hint";
      none.textContent = "Aucun technicien enregistré pour l’instant.";
      techList.appendChild(none);
    }
    state.techniciens.forEach(function (t) {
      var chip = document.createElement("span");
      chip.className = "tech-chip";

      var init = document.createElement("span");
      init.className = "init";
      init.textContent = t.initiales;
      chip.appendChild(init);

      if (t.nom) {
        var nom = document.createElement("span");
        nom.className = "nom";
        nom.textContent = t.nom;
        chip.appendChild(nom);
      }

      var del = document.createElement("button");
      del.className = "del";
      del.type = "button";
      del.title = "Retirer ce technicien";
      del.textContent = "×";
      del.onclick = function () {
        api("/api/admin/techniciens/" + t.id, { method: "DELETE" }).then(refreshAll);
      };
      chip.appendChild(del);

      techList.appendChild(chip);
    });
  }

  function renderColonneList() {
    var list = document.getElementById("colonneList");
    list.innerHTML = "";
    var sorted = state.colonnes.slice().sort(function (a, b) { return a.ordre - b.ordre; });
    sorted.forEach(function (col, idx) {
      var row = document.createElement("div");
      row.className = "colonne-row";

      var ordre = document.createElement("span");
      ordre.className = "ordre mono";
      ordre.textContent = (idx + 1) + ".";
      row.appendChild(ordre);

      var nom = document.createElement("span");
      nom.className = "nom";
      nom.textContent = col.nom;
      row.appendChild(nom);

      var moveBtns = document.createElement("div");
      moveBtns.className = "move-btns";

      var upBtn = document.createElement("button");
      upBtn.className = "icon-btn";
      upBtn.type = "button";
      upBtn.textContent = "↑";
      upBtn.disabled = idx === 0;
      upBtn.onclick = function () {
        api("/api/admin/colonnes/" + col.id + "/move", { method: "POST", body: { direction: "up" } }).then(refreshAll);
      };
      moveBtns.appendChild(upBtn);

      var downBtn = document.createElement("button");
      downBtn.className = "icon-btn";
      downBtn.type = "button";
      downBtn.textContent = "↓";
      downBtn.disabled = idx === sorted.length - 1;
      downBtn.onclick = function () {
        api("/api/admin/colonnes/" + col.id + "/move", { method: "POST", body: { direction: "down" } }).then(refreshAll);
      };
      moveBtns.appendChild(downBtn);

      var delBtn = document.createElement("button");
      delBtn.className = "icon-btn danger";
      delBtn.type = "button";
      delBtn.title = "Supprimer cette colonne";
      delBtn.textContent = "×";
      delBtn.onclick = function () {
        if (window.confirm("Supprimer la colonne « " + col.nom + " » ? Les cases déjà cochées pour cette colonne seront perdues.")) {
          api("/api/admin/colonnes/" + col.id, { method: "DELETE" }).then(refreshAll);
        }
      };
      moveBtns.appendChild(delBtn);

      row.appendChild(moveBtns);
      list.appendChild(row);
    });
  }

  // ---------- board ----------

  function renderBoard() {
    var empty = document.getElementById("emptyState");
    var wrap = document.getElementById("boardWrap");

    if (state.chantiers.length === 0) {
      empty.hidden = false;
      wrap.hidden = true;
      document.getElementById("emptyStateSub").textContent = state.isAdmin
        ? "Ajoutez le premier chantier ci-dessus."
        : "Dès qu’un chantier sera ajouté par l’admin, il apparaîtra ici.";
      return;
    }
    empty.hidden = true;
    wrap.hidden = false;

    var colonnes = state.colonnes.slice().sort(function (a, b) { return a.ordre - b.ordre; });

    // header row
    var headRow = document.getElementById("boardHeadRow");
    headRow.innerHTML = "";
    var thChantier = document.createElement("th");
    thChantier.className = "sticky-col";
    thChantier.textContent = "Chantier";
    headRow.appendChild(thChantier);
    colonnes.forEach(function (col) {
      var th = document.createElement("th");
      th.textContent = col.nom;
      headRow.appendChild(th);
    });

    // body
    var body = document.getElementById("boardBody");
    body.innerHTML = "";
    state.chantiers.forEach(function (ch) {
      var tr = document.createElement("tr");

      var tdChantier = document.createElement("td");
      tdChantier.className = "sticky-col";

      var nomEl = document.createElement("div");
      nomEl.className = "chantier-cell-nom";
      nomEl.textContent = ch.nom || "(sans nom)";
      tdChantier.appendChild(nomEl);

      if (ch.adresse) {
        var adrEl = document.createElement("div");
        adrEl.className = "chantier-cell-adr";
        adrEl.textContent = ch.adresse;
        tdChantier.appendChild(adrEl);
      }

      if (state.isAdmin) {
        var actions = document.createElement("div");
        actions.className = "chantier-cell-actions";

        var editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.textContent = "Modifier";
        editBtn.onclick = function () { startEditChantier(tdChantier, ch); };
        actions.appendChild(editBtn);

        var delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "danger";
        delBtn.textContent = "Supprimer";
        delBtn.onclick = function () { confirmDeleteChantier(ch); };
        actions.appendChild(delBtn);

        tdChantier.appendChild(actions);
      }

      tr.appendChild(tdChantier);

      colonnes.forEach(function (col) {
        var td = document.createElement("td");
        td.className = "data-cell";
        var cell = state.cellsByKey[cellKey(ch.id, col.id)];
        var btn = document.createElement("button");
        btn.type = "button";

        var isDateCol = isDateColonne(col);

        if (cell) {
          btn.className = "cell-btn done" + (cell.commentaire ? " has-comment" : "");
          if (isDateCol && cell.dateValue) {
            var uc = receptionUrgencyColors(cell.dateValue);
            btn.style.background = uc.bg;
            btn.style.color = uc.fg;
            var dateBig = document.createElement("span");
            dateBig.className = "init";
            dateBig.textContent = formatDateValue(cell.dateValue);
            btn.appendChild(dateBig);
            btn.title = cell.commentaire
              ? "Réception le " + formatDateValue(cell.dateValue) + " — contient un commentaire, cliquer pour le lire"
              : (uc.daysUntil < 0
                ? "Réception prévue le " + formatDateValue(cell.dateValue) + " — échéance dépassée"
                : "Réception prévue le " + formatDateValue(cell.dateValue));
          } else {
            var initSpan = document.createElement("span");
            initSpan.className = "init";
            initSpan.textContent = cell.initiales;
            var dateSpan = document.createElement("span");
            dateSpan.className = "date";
            dateSpan.textContent = formatDate(cell.date);
            btn.appendChild(initSpan);
            btn.appendChild(dateSpan);
            btn.title = cell.commentaire
              ? "Contient un commentaire — cliquer pour le lire"
              : "Terminé par " + cell.initiales;
          }
          btn.onclick = function () { openCellModal(ch, col, cell); };
        } else {
          btn.className = "cell-btn";
          btn.textContent = "+";
          btn.disabled = state.techniciens.length === 0;
          btn.title = state.techniciens.length === 0
            ? "Aucun technicien enregistré (contactez l’admin)"
            : (isDateCol ? "Choisir une date de réception" : "Marquer terminé");
          btn.onclick = function () { openCellModal(ch, col, null); };
        }

        td.appendChild(btn);
        tr.appendChild(td);
      });

      body.appendChild(tr);
    });
  }

  function startEditChantier(tdChantier, ch) {
    tdChantier.innerHTML = "";
    var row = document.createElement("div");
    row.className = "chantier-edit-row";

    var nomInput = document.createElement("input");
    nomInput.type = "text";
    nomInput.value = ch.nom || "";
    nomInput.placeholder = "Nom du chantier";
    row.appendChild(nomInput);

    var adrInput = document.createElement("input");
    adrInput.type = "text";
    adrInput.value = ch.adresse || "";
    adrInput.placeholder = "Adresse (optionnel)";
    row.appendChild(adrInput);

    var editActions = document.createElement("div");
    editActions.className = "edit-actions";

    var saveBtn = document.createElement("button");
    saveBtn.className = "btn btn-primary btn-sm";
    saveBtn.textContent = "OK";
    saveBtn.onclick = function () {
      var nom = nomInput.value.trim();
      if (!nom) return;
      api("/api/admin/chantiers/" + ch.id, { method: "PUT", body: { nom: nom, adresse: adrInput.value.trim() } }).then(refreshAll);
    };
    editActions.appendChild(saveBtn);

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-sm";
    cancelBtn.textContent = "Annuler";
    cancelBtn.onclick = function () { renderBoard(); };
    editActions.appendChild(cancelBtn);

    row.appendChild(editActions);
    tdChantier.appendChild(row);
    nomInput.focus();
  }

  function confirmDeleteChantier(ch) {
    if (window.confirm("Supprimer « " + (ch.nom || "ce chantier") + " » et toutes ses cases cochées ? Cette action est définitive.")) {
      api("/api/admin/chantiers/" + ch.id, { method: "DELETE" }).then(refreshAll);
    }
  }

  // ---------- cell modal ----------

  function openCellModal(chantier, colonne, cell) {
    var isDateCol = isDateColonne(colonne);
    state.activeCellCtx = { chantierId: chantier.id, colonneId: colonne.id, cell: cell, colonneType: colonne.type };
    var backdrop = document.getElementById("cellBackdrop");
    var title = document.getElementById("cellModalTitle");
    var sub = document.getElementById("cellModalSub");
    var formView = document.getElementById("cellFormView");
    var detailView = document.getElementById("cellDetailView");

    sub.textContent = (chantier.nom || "") + " — " + (colonne.nom || "");

    if (cell) {
      title.textContent = isDateCol ? "Date de réception" : "Terminé";
      formView.hidden = true;
      detailView.hidden = false;
      if (isDateCol && cell.dateValue) {
        document.getElementById("cellDetailInit").textContent = formatDateValue(cell.dateValue);
        document.getElementById("cellDetailDate").textContent = "renseigné par " + cell.initiales + " le " + formatDate(cell.date);
      } else {
        document.getElementById("cellDetailInit").textContent = cell.initiales;
        document.getElementById("cellDetailDate").textContent = formatDate(cell.date);
      }
      var commentBox = document.getElementById("cellDetailComment");
      if (cell.commentaire) {
        commentBox.hidden = false;
        commentBox.textContent = cell.commentaire;
      } else {
        commentBox.hidden = true;
      }
      document.getElementById("cellResetBtn").hidden = !state.isAdmin;
    } else {
      title.textContent = isDateCol ? "Choisir la date de réception" : "Marquer terminé";
      formView.hidden = false;
      detailView.hidden = true;
      var select = document.getElementById("cellInitialesSelect");
      select.innerHTML = "";
      var lastUsed = safeGetLS(LS_INITIALES);
      state.techniciens.forEach(function (t) {
        var opt = document.createElement("option");
        opt.value = t.initiales;
        opt.textContent = t.nom ? (t.initiales + " — " + t.nom) : t.initiales;
        if (t.initiales === lastUsed) opt.selected = true;
        select.appendChild(opt);
      });

      var dateField = document.getElementById("cellDateField");
      var dateInput = document.getElementById("cellDateInput");
      dateField.hidden = !isDateCol;
      if (isDateCol) {
        dateInput.value = "";
        setTimeout(function () { dateInput.focus(); }, 30);
      }

      document.getElementById("cellCommentInput").value = "";
      document.getElementById("cellFormError").textContent = "";
    }

    backdrop.hidden = false;
  }

  function closeCellModal() {
    document.getElementById("cellBackdrop").hidden = true;
    state.activeCellCtx = null;
  }

  function wireCellModal() {
    document.getElementById("cellCancelBtn").onclick = closeCellModal;
    document.getElementById("cellCloseBtn").onclick = closeCellModal;

    document.getElementById("cellValidBtn").onclick = function () {
      var ctx = state.activeCellCtx;
      if (!ctx) return;
      var initiales = document.getElementById("cellInitialesSelect").value;
      var commentaire = document.getElementById("cellCommentInput").value.trim();
      var err = document.getElementById("cellFormError");
      if (!initiales) {
        err.textContent = "Sélectionnez vos initiales.";
        return;
      }
      var body = { chantierId: ctx.chantierId, colonneId: ctx.colonneId, initiales: initiales, commentaire: commentaire };
      if (ctx.colonneType === "date") {
        var dateValue = document.getElementById("cellDateInput").value;
        if (!dateValue) {
          err.textContent = "Choisissez une date.";
          return;
        }
        body.dateValue = dateValue;
      }
      safeSetLS(LS_INITIALES, initiales);
      api("/api/cells", { method: "POST", body: body })
        .then(function () {
          closeCellModal();
          return refreshAll();
        })
        .catch(function (e) {
          if (e.status === 409) {
            err.textContent = "Cette case vient d’être marquée par quelqu’un d’autre.";
            refreshAll();
          } else if (e.status === 400 && e.data && e.data.error === "invalid_date") {
            err.textContent = "Date invalide.";
          } else {
            err.textContent = "Échec de l’envoi, réessayez.";
          }
        });
    };

    document.getElementById("cellResetBtn").onclick = function () {
      var ctx = state.activeCellCtx;
      if (!ctx || !ctx.cell) return;
      api("/api/admin/cells/" + ctx.cell.id, { method: "DELETE" }).then(function () {
        closeCellModal();
        return refreshAll();
      });
    };
  }

  // ---------- display settings ----------

  function currentTheme() {
    return safeGetLS(LS_THEME) || "light";
  }

  function applyTheme(theme) {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute("data-theme", theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    safeSetLS(LS_THEME, theme);
  }

  function applyCustomBg(hex) {
    if (hex) {
      document.documentElement.style.setProperty("--paper", hex);
      safeSetLS(LS_BG_CUSTOM, hex);
    } else {
      document.documentElement.style.removeProperty("--paper");
      try { localStorage.removeItem(LS_BG_CUSTOM); } catch (e) { /* ignore */ }
    }
  }

  function renderThemeChoiceActive() {
    var theme = currentTheme();
    document.querySelectorAll(".theme-opt").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.themeChoice === theme);
    });
  }

  function applyLayoutWidth() {
    var full = !!(state.settings && state.settings.fullWidth);
    var wrap = document.querySelector(".wrap");
    var headerRow = document.querySelector(".header-row");
    if (wrap) wrap.classList.toggle("full-width", full);
    if (headerRow) headerRow.classList.toggle("full-width", full);
  }

  function renderWidthChoiceActive() {
    var full = !!(state.settings && state.settings.fullWidth);
    document.querySelectorAll(".width-opt").forEach(function (btn) {
      var isFull = btn.dataset.widthChoice === "full";
      btn.classList.toggle("active", isFull === full);
    });
  }

  function wireWidthControls() {
    document.querySelectorAll(".width-opt").forEach(function (btn) {
      btn.onclick = function () {
        var fullWidth = btn.dataset.widthChoice === "full";
        api("/api/admin/settings", { method: "POST", body: { fullWidth: fullWidth } }).then(function (data) {
          state.settings = data || { fullWidth: fullWidth };
          applyLayoutWidth();
          renderWidthChoiceActive();
        });
      };
    });
  }

  function applyZoom() {
    var z = (state.settings && state.settings.zoomLevel) ? state.settings.zoomLevel : 100;
    document.body.style.zoom = z / 100;
  }

  function renderZoomControlActive() {
    var z = (state.settings && state.settings.zoomLevel) ? state.settings.zoomLevel : 100;
    var range = document.getElementById("zoomRange");
    var label = document.getElementById("zoomValueLabel");
    if (range) range.value = z;
    if (label) label.textContent = z + "%";
  }

  function wireZoomControl() {
    var range = document.getElementById("zoomRange");
    if (!range) return;
    range.oninput = function () {
      var label = document.getElementById("zoomValueLabel");
      if (label) label.textContent = range.value + "%";
    };
    range.onchange = function () {
      var zoomLevel = parseInt(range.value, 10);
      api("/api/admin/settings", { method: "POST", body: { zoomLevel: zoomLevel } }).then(function (data) {
        state.settings = data || state.settings;
        applyZoom();
        renderZoomControlActive();
      });
    };
  }

  function openSettingsModal() {
    renderThemeChoiceActive();
    var storedBg = safeGetLS(LS_BG_CUSTOM);
    document.getElementById("bgColorInput").value = storedBg || DEFAULT_PAPER_LIGHT;
    document.getElementById("settingsBackdrop").hidden = false;
  }
  function closeSettingsModal() { document.getElementById("settingsBackdrop").hidden = true; }

  function wireSettingsModal() {
    document.getElementById("settingsBtn").onclick = openSettingsModal;
    document.getElementById("settingsCloseBtn").onclick = closeSettingsModal;

    document.querySelectorAll(".theme-opt").forEach(function (btn) {
      btn.onclick = function () {
        applyTheme(btn.dataset.themeChoice);
        renderThemeChoiceActive();
        renderBoard();
      };
    });

    document.getElementById("bgColorInput").addEventListener("input", function (e) {
      applyCustomBg(e.target.value);
    });

    document.getElementById("bgResetBtn").onclick = function () {
      applyCustomBg(null);
      document.getElementById("bgColorInput").value = DEFAULT_PAPER_LIGHT;
    };
  }

  // ---------- login modal ----------

  function openLoginModal() {
    var backdrop = document.getElementById("loginBackdrop");
    var input = document.getElementById("loginPasswordInput");
    var err = document.getElementById("loginError");
    input.value = "";
    err.textContent = "";
    backdrop.hidden = false;
    setTimeout(function () { input.focus(); }, 30);
  }
  function closeLoginModal() { document.getElementById("loginBackdrop").hidden = true; }

  function wireLoginModal() {
    document.getElementById("loginCancel").onclick = closeLoginModal;
    document.getElementById("loginSubmit").onclick = function () {
      var val = document.getElementById("loginPasswordInput").value;
      api("/api/admin/login", { method: "POST", body: { password: val } }).then(function () {
        state.isAdmin = true;
        closeLoginModal();
        return refreshAll();
      }).catch(function () {
        document.getElementById("loginError").textContent = "Mot de passe incorrect.";
      });
    };
    document.getElementById("loginPasswordInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter") document.getElementById("loginSubmit").click();
    });
  }

  // ---------- tutorial modal ----------

  function openTutoModal() {
    document.getElementById("tutoBackdrop").hidden = false;
  }
  function closeTutoModal() {
    document.getElementById("tutoBackdrop").hidden = true;
    safeSetLS(LS_TUTO_SEEN, "1");
  }
  function wireTutoModal() {
    document.getElementById("helpBtn").onclick = openTutoModal;
    document.getElementById("tutoCloseBtn").onclick = closeTutoModal;
  }

  // ---------- admin panel static controls ----------

  function wireStaticControls() {
    document.getElementById("addChantierBtn").onclick = function () {
      var nomInput = document.getElementById("newChantierNom");
      var adrInput = document.getElementById("newChantierAdresse");
      var nom = nomInput.value.trim();
      if (!nom) return;
      api("/api/admin/chantiers", { method: "POST", body: { nom: nom, adresse: adrInput.value.trim() } })
        .then(function () {
          nomInput.value = "";
          adrInput.value = "";
          nomInput.focus();
          return refreshAll();
        });
    };
    document.getElementById("newChantierNom").addEventListener("keydown", function (e) {
      if (e.key === "Enter") document.getElementById("addChantierBtn").click();
    });

    document.getElementById("addTechBtn").onclick = function () {
      var initInput = document.getElementById("newTechInitiales");
      var nomInput = document.getElementById("newTechNom");
      var initiales = initInput.value.trim();
      if (!initiales) return;
      api("/api/admin/techniciens", { method: "POST", body: { initiales: initiales, nom: nomInput.value.trim() } })
        .then(function () {
          initInput.value = "";
          nomInput.value = "";
          initInput.focus();
          return refreshAll();
        });
    };
    document.getElementById("newTechInitiales").addEventListener("keydown", function (e) {
      if (e.key === "Enter") document.getElementById("addTechBtn").click();
    });

    document.getElementById("addColonneBtn").onclick = function () {
      var input = document.getElementById("newColonneNom");
      var isDateCheckbox = document.getElementById("newColonneIsDate");
      var nom = input.value.trim();
      if (!nom) return;
      var type = isDateCheckbox && isDateCheckbox.checked ? "date" : "task";
      api("/api/admin/colonnes", { method: "POST", body: { nom: nom, type: type } }).then(function () {
        input.value = "";
        if (isDateCheckbox) isDateCheckbox.checked = false;
        input.focus();
        return refreshAll();
      });
    };
    document.getElementById("newColonneNom").addEventListener("keydown", function (e) {
      if (e.key === "Enter") document.getElementById("addColonneBtn").click();
    });

    document.getElementById("changePasswordBtn").onclick = function () {
      var input = document.getElementById("newPasswordInput");
      var msg = document.getElementById("passwordMsg");
      var val = input.value;
      if (val.length < 4) {
        msg.style.color = "var(--danger)";
        msg.textContent = "Au moins 4 caractères.";
        return;
      }
      api("/api/admin/password", { method: "POST", body: { newPassword: val } }).then(function () {
        msg.style.color = "var(--done)";
        msg.textContent = "Mot de passe mis à jour.";
        input.value = "";
      }).catch(function () {
        msg.style.color = "var(--danger)";
        msg.textContent = "Échec de la mise à jour.";
      });
    };
  }

  // ---------- refresh / polling ----------

  function renderAll() {
    renderHeaderActions();
    renderAdminPanel();
    renderBoard();
    renderStatus();
    applyLayoutWidth();
    applyZoom();
  }

  function refreshAll() {
    return Promise.all([fetchBoard(), fetchTechniciens(), fetchMe(), fetchSettings()])
      .then(renderAll)
      .catch(function () {
        state.online = false;
        renderStatus();
      });
  }

  function boot() {
    wireSettingsModal();
    wireLoginModal();
    wireCellModal();
    wireStaticControls();
    wireWidthControls();
    wireZoomControl();
    wireTutoModal();
    refreshAll();
    if (!safeGetLS(LS_TUTO_SEEN)) {
      openTutoModal();
    }
    setInterval(function () {
      var cellModalOpen = !document.getElementById("cellBackdrop").hidden;
      if (cellModalOpen) return;
      refreshAll();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
