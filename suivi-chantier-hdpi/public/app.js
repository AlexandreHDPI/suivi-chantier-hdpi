(function () {
  "use strict";

  var LS_INITIALES = "hdpi_suivi_initiales";
  var POLL_MS = 8000;

  var state = {
    isAdmin: false,
    online: false,
    chantiers: [], // [{id, nom, adresse, interventions:[{id,initiales,commentaire,date}]}]
    techniciens: [], // [{id, initiales, nom}]
    openDoneForm: null,
    openComments: {},
  };

  function safeGetLS(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function safeSetLS(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function formatDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    var dd = String(d.getDate()).padStart(2, "0");
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    return dd + "/" + mm;
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

  function fetchChantiers() {
    return api("/api/chantiers").then(function (data) {
      state.chantiers = data;
      state.online = true;
    });
  }
  function fetchTechniciens() {
    return api("/api/techniciens").then(function (data) {
      state.techniciens = data;
    });
  }
  function fetchMe() {
    return api("/api/admin/me").then(function (data) {
      state.isAdmin = !!(data && data.authenticated);
    });
  }

  // ---------- rendering ----------

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

  function renderAdminPanel() {
    var panel = document.getElementById("adminPanel");
    panel.hidden = !state.isAdmin;
    if (!state.isAdmin) return;

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

  function renderList() {
    var list = document.getElementById("chantierList");
    var empty = document.getElementById("emptyState");

    Array.prototype.slice.call(list.querySelectorAll(".chantier")).forEach(function (n) { n.remove(); });

    if (state.chantiers.length === 0) {
      empty.hidden = false;
      document.getElementById("emptyStateSub").textContent = state.isAdmin
        ? "Ajoutez le premier chantier ci-dessus."
        : "Dès qu’un chantier sera ajouté par l’admin, il apparaîtra ici.";
      return;
    }
    empty.hidden = true;

    state.chantiers.forEach(function (ch) {
      list.appendChild(renderChantier(ch));
    });
  }

  function renderChantier(ch) {
    var panel = document.createElement("div");
    panel.className = "chantier";
    panel.dataset.id = ch.id;

    var head = document.createElement("div");
    head.className = "chantier-head";

    var titles = document.createElement("div");
    titles.className = "chantier-titles";
    var nomEl = document.createElement("div");
    nomEl.className = "chantier-nom";
    nomEl.textContent = ch.nom || "(sans nom)";
    titles.appendChild(nomEl);
    if (ch.adresse) {
      var adr = document.createElement("div");
      adr.className = "chantier-adresse";
      adr.textContent = ch.adresse;
      titles.appendChild(adr);
    }
    head.appendChild(titles);

    if (state.isAdmin) {
      var actions = document.createElement("div");
      actions.className = "chantier-admin-actions";

      var editBtn = document.createElement("button");
      editBtn.className = "btn btn-ghost btn-sm";
      editBtn.textContent = "Modifier";
      editBtn.onclick = function () { startEditChantier(panel, ch); };
      actions.appendChild(editBtn);

      var delBtn = document.createElement("button");
      delBtn.className = "btn btn-ghost btn-sm";
      delBtn.style.color = "var(--danger)";
      delBtn.textContent = "Supprimer";
      delBtn.onclick = function () { confirmDeleteChantier(ch); };
      actions.appendChild(delBtn);

      head.appendChild(actions);
    }

    panel.appendChild(head);

    var interventions = ch.interventions || [];

    if (interventions.length === 0) {
      var pending = document.createElement("div");
      pending.className = "no-interventions";
      pending.textContent = "En attente";
      panel.appendChild(pending);
    } else {
      var chipsWrap = document.createElement("div");
      chipsWrap.className = "chips";
      interventions.forEach(function (iv) {
        chipsWrap.appendChild(renderChip(ch, iv));
      });
      panel.appendChild(chipsWrap);

      interventions.forEach(function (iv) {
        if (iv.commentaire && state.openComments[iv.id]) {
          var box = document.createElement("div");
          box.className = "comment-box";
          box.textContent = iv.initiales + " — " + iv.commentaire;
          panel.appendChild(box);
        }
      });
    }

    var actionsRow = document.createElement("div");
    actionsRow.className = "chantier-actions";
    if (state.openDoneForm === ch.id) {
      actionsRow.appendChild(renderDoneForm(ch));
    } else {
      var doneBtn = document.createElement("button");
      doneBtn.className = "btn btn-primary";
      doneBtn.textContent = "Marquer terminé";
      doneBtn.disabled = state.techniciens.length === 0;
      doneBtn.title = state.techniciens.length === 0 ? "Aucun technicien enregistré (contactez l’admin)" : "";
      doneBtn.onclick = function () {
        state.openDoneForm = ch.id;
        renderList();
      };
      actionsRow.appendChild(doneBtn);
    }
    panel.appendChild(actionsRow);

    return panel;
  }

  function renderChip(ch, iv) {
    var chip = document.createElement("span");
    chip.className = "chip";

    var init = document.createElement("span");
    init.className = "init";
    init.textContent = iv.initiales || "?";
    chip.appendChild(init);

    var date = document.createElement("span");
    date.className = "date mono";
    date.textContent = formatDate(iv.date);
    chip.appendChild(date);

    if (iv.commentaire) {
      var toggle = document.createElement("button");
      toggle.className = "comment-toggle";
      toggle.type = "button";
      toggle.textContent = state.openComments[iv.id] ? "masquer" : "note";
      toggle.onclick = function () {
        state.openComments[iv.id] = !state.openComments[iv.id];
        renderList();
      };
      chip.appendChild(toggle);
    }

    if (state.isAdmin) {
      var del = document.createElement("button");
      del.className = "del";
      del.type = "button";
      del.title = "Annuler ce terminé";
      del.textContent = "×";
      del.onclick = function () {
        api("/api/admin/interventions/" + iv.id, { method: "DELETE" }).then(refreshAll);
      };
      chip.appendChild(del);
    }

    return chip;
  }

  function renderDoneForm(ch) {
    var wrap = document.createElement("div");
    wrap.className = "done-form";
    wrap.style.width = "100%";

    var row = document.createElement("div");
    row.className = "done-form-row";

    var initField = document.createElement("div");
    initField.className = "field";
    var initLabel = document.createElement("label");
    initLabel.textContent = "Technicien";
    var select = document.createElement("select");
    var lastUsed = safeGetLS(LS_INITIALES);
    state.techniciens.forEach(function (t) {
      var opt = document.createElement("option");
      opt.value = t.initiales;
      opt.textContent = t.nom ? (t.initiales + " — " + t.nom) : t.initiales;
      if (t.initiales === lastUsed) opt.selected = true;
      select.appendChild(opt);
    });
    initField.appendChild(initLabel);
    initField.appendChild(select);
    row.appendChild(initField);

    var comField = document.createElement("div");
    comField.className = "field grow";
    var comLabel = document.createElement("label");
    comLabel.textContent = "Commentaire (optionnel)";
    var comInput = document.createElement("textarea");
    comInput.rows = 1;
    comInput.placeholder = "Ex. plan mis à jour, prévoir un retour…";
    comField.appendChild(comLabel);
    comField.appendChild(comInput);
    row.appendChild(comField);

    wrap.appendChild(row);

    var err = document.createElement("div");
    err.className = "error-msg";
    wrap.appendChild(err);

    var actionsRow = document.createElement("div");
    actionsRow.className = "done-form-actions";

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-sm";
    cancelBtn.textContent = "Annuler";
    cancelBtn.onclick = function () { state.openDoneForm = null; renderList(); };
    actionsRow.appendChild(cancelBtn);

    var validBtn = document.createElement("button");
    validBtn.className = "btn btn-primary btn-sm";
    validBtn.textContent = "Valider";
    validBtn.onclick = function () {
      var initiales = select.value;
      if (!initiales) {
        err.textContent = "Sélectionnez vos initiales.";
        return;
      }
      validBtn.disabled = true;
      safeSetLS(LS_INITIALES, initiales);
      api("/api/interventions", {
        method: "POST",
        body: { chantierId: ch.id, initiales: initiales, commentaire: comInput.value.trim() },
      }).then(function () {
        state.openDoneForm = null;
        return refreshAll();
      }).catch(function () {
        err.textContent = "Échec de l’envoi, réessayez.";
        validBtn.disabled = false;
      });
    };
    actionsRow.appendChild(validBtn);

    wrap.appendChild(actionsRow);
    return wrap;
  }

  function startEditChantier(panel, ch) {
    var head = panel.querySelector(".chantier-head");
    head.innerHTML = "";
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
      api("/api/admin/chantiers/" + ch.id, {
        method: "PUT",
        body: { nom: nom, adresse: adrInput.value.trim() },
      }).then(refreshAll);
    };
    editActions.appendChild(saveBtn);

    var cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-sm";
    cancelBtn.textContent = "Annuler";
    cancelBtn.onclick = function () { renderList(); };
    editActions.appendChild(cancelBtn);

    row.appendChild(editActions);
    head.appendChild(row);
    nomInput.focus();
  }

  function confirmDeleteChantier(ch) {
    if (window.confirm("Supprimer « " + (ch.nom || "ce chantier") + " » et toutes ses entrées ? Cette action est définitive.")) {
      api("/api/admin/chantiers/" + ch.id, { method: "DELETE" }).then(refreshAll);
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

  function renderAll() {
    renderHeaderActions();
    renderAdminPanel();
    renderList();
    renderStatus();
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

  function wireModal() {
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

    document.getElementById("changePasswordBtn").onclick = function () {
      var input = document.getElementById("newPasswordInput");
      var msg = document.getElementById("passwordMsg");
      var val = input.value;
      if (val.length < 4) {
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

  function refreshAll() {
    return Promise.all([fetchChantiers(), fetchTechniciens(), fetchMe()])
      .then(renderAll)
      .catch(function () {
        state.online = false;
        renderStatus();
      });
  }

  function boot() {
    wireModal();
    wireStaticControls();
    refreshAll();
    setInterval(function () {
      // Don't refetch while a form is actively open, to avoid disrupting typing.
      if (state.openDoneForm) return;
      refreshAll();
    }, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
