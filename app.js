/* Planning à deux — site statique (GitHub Pages).
   Les horaires sont dans un fichier planning.json d'un dépôt GitHub PRIVÉ, lu et écrit avec l'API GitHub et un
   jeton limité à ce dépôt. Chaque modification prévient l'autre personne par une notification ntfy.
   Rien n'est envoyé ailleurs : seulement api.github.com (vos données) et ntfy.sh (la notification). */
"use strict";
(() => {
  /* ------------------------------------------------------------------ mémoire de l'appareil */
  const memoire = {
    lire(cle, defaut = null) {
      try { const v = localStorage.getItem("planning2." + cle); return v == null ? defaut : JSON.parse(v); } catch { return defaut; }
    },
    ecrire(cle, valeur) { try { localStorage.setItem("planning2." + cle, JSON.stringify(valeur)); } catch { /* stockage refusé */ } },
    effacer(cle) { try { localStorage.removeItem("planning2." + cle); } catch { /* rien */ } },
  };
  const API = memoire.lire("api") || "https://api.github.com";   // (les deux réglages cachés servent aux tests)
  const NTFY = memoire.lire("ntfy") || "https://ntfy.sh";
  const ATTENTE = memoire.lire("poll") || 20000;                   // relecture du planning toutes les 20 s
  const FICHIER = "planning.json";
  const COULEURS = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed", "#0891b2"];
  const SUGGESTIONS = ["Travail", "Repos", "Congé", "Sport", "Rendez-vous", "Sortie"];
  const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const JOURS_COURTS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
  const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const MOIS_COURTS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const GARDER_JOURS = 180;   // les horaires plus vieux que 6 mois sont retirés (ils restent dans l'historique GitHub)
  const LIEN_JETON = "https://github.com/settings/personal-access-tokens/new?name=Planning+a+deux"
    + "&description=" + encodeURIComponent("Site Planning à deux : lecture et écriture du dépôt des données")
    + "&expires_in=366&contents=write";
  const LIEN_NTFY_IOS = "https://apps.apple.com/app/id1625396347";
  const LIEN_NTFY_ANDROID = "https://play.google.com/store/apps/details?id=io.heckel.ntfy";

  let config = memoire.lire("config");   // { depot: "pseudo/depot", jeton, moi: "p1" | "p2", jeton_le: "AAAA-MM-JJ" }
  let donnees = null, sha = null, occupe = 0;
  let lundi = debutSemaine(new Date());
  let seuilNouveau = null;               // les horaires changés par l'autre après ce moment sont marqués « nouveau »
  const eclairs = new Set();             // horaires qui viennent d'arriver : petit éclat jaune à l'affichage
  const $ = (s) => document.querySelector(s);
  const fenetre = $("#fenetre");

  /* ------------------------------------------------------------------ dates */
  const pad = (n) => String(n).padStart(2, "0");
  function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function lireDate(s) { const [a, m, j] = s.split("-").map(Number); return new Date(a, m - 1, j); }
  function ajouterJours(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function debutSemaine(d) { return ajouterJours(d, -((d.getDay() + 6) % 7)); }
  function joursEntre(a, b) { return Math.round((lireDate(b) - lireDate(a)) / 86400000); }
  function dateTxt(s) { const d = lireDate(s); return `${JOURS_COURTS[d.getDay()]} ${d.getDate()} ${MOIS_COURTS[d.getMonth()]}`; }
  function numeroSemaine(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    return Math.ceil(((t - new Date(Date.UTC(t.getUTCFullYear(), 0, 1))) / 86400000 + 1) / 7);
  }
  function maintenant() { return new Date().toISOString(); }
  function quandTxt(s) {
    const d = new Date(s), sec = (Date.now() - d) / 1000, h = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (sec < 60) return "à l'instant";
    if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
    const auj = iso(new Date()), jour = iso(d);
    if (jour === auj) return `aujourd'hui à ${h}`;
    if (jour === iso(ajouterJours(new Date(), -1))) return `hier à ${h}`;
    return `${dateTxt(jour)} à ${h}`;
  }

  /* ------------------------------------------------------------------ petits outils */
  function el(tag, props = {}, ...enfants) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "classe") e.className = v;
      else if (k === "texte") e.textContent = v;
      else if (k === "couleur") e.style.setProperty("--c", v);
      else if (k === "value" || k === "checked") e[k] = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of enfants.flat(3)) if (c != null && c !== false) e.append(c);
    return e;
  }
  function aleatoire(n) {
    const lettres = "abcdefghijkmnpqrstuvwxyz23456789", o = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(o, (x) => lettres[x % lettres.length]).join("");
  }
  const nouvelId = (p) => `${p}-${aleatoire(10)}`;
  function vers64(texte) {
    const o = new TextEncoder().encode(texte);
    let s = "";
    for (let i = 0; i < o.length; i += 0x8000) s += String.fromCharCode.apply(null, o.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function depuis64(b) {
    const s = atob(b.replace(/\s/g, ""));
    return new TextDecoder().decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  }
  function toast(texte, genre = "ok", bouton = null) {
    const t = el("div", { classe: "toast" + (genre === "erreur" ? " erreur" : ""), role: genre === "erreur" ? "alert" : "status" },
      el("span", { texte }),
      bouton ? el("button", { type: "button", texte: bouton.texte, onclick: () => { t.remove(); bouton.action(); } }) : null);
    $("#toasts").append(t);
    setTimeout(() => t.remove(), bouton ? 9000 : 5000);
  }
  function etatSync(texte, bouton = null) {
    const b = $("#etat-sync");
    b.replaceChildren();
    b.hidden = !texte;
    if (texte) b.append(el("span", { texte }), bouton ? el("button", { type: "button", classe: "bouton petit", texte: bouton.texte, onclick: bouton.action }) : null);
  }
  async function copier(texte) {
    try { await navigator.clipboard.writeText(texte); toast("Copié."); } catch { toast("Sélectionnez le texte et copiez-le à la main.", "erreur"); }
  }
  const personne = (id) => donnees.personnes.find((p) => p.id === id) || { id, nom: "?", couleur: "#64748b" };
  const autre = () => donnees.personnes.find((p) => p.id !== config.moi);

  /* ------------------------------------------------------------------ GitHub */
  class ErreurGitHub extends Error {
    constructor(statut, message) { super(message || `GitHub : erreur ${statut}`); this.statut = statut; }
  }
  async function gh(chemin, options = {}, jeton = config && config.jeton, depot = config && config.depot) {
    const url = API + chemin.replace("{depot}", depot.split("/").map(encodeURIComponent).join("/"));
    let r;
    try {
      r = await fetch(url, {
        ...options, cache: "no-store",
        headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + jeton, ...(options.headers || {}) },
      });
    } catch {
      throw new ErreurGitHub(0, "Pas de connexion à GitHub.");
    }
    return r;
  }
  async function echec(r) {
    let m = "";
    try { m = (await r.json()).message || ""; } catch { /* pas de JSON */ }
    return new ErreurGitHub(r.status, m);
  }
  async function lireFichier(jeton, depot) {
    const r = await gh(`/repos/{depot}/contents/${FICHIER}`, {}, jeton, depot);
    if (r.status === 404) return null;
    if (!r.ok) throw await echec(r);
    const j = await r.json();
    return { donnees: normaliser(JSON.parse(depuis64(j.content))), sha: j.sha };
  }
  async function verifierDepot(jeton, depot) {
    const r = await gh("/repos/{depot}", {}, jeton, depot);
    if (!r.ok) throw await echec(r);
  }
  async function ecrireFichier(d, shaAvant, message, jeton, depot) {
    const corps = { message, content: vers64(JSON.stringify(d, null, 1) + "\n") };
    if (shaAvant) corps.sha = shaAvant;
    const r = await gh(`/repos/{depot}/contents/${FICHIER}`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps),
    }, jeton, depot);
    if (r.status === 409 || r.status === 422) { const e = await echec(r); e.conflit = true; throw e; }
    if (!r.ok) throw await echec(r);
    return (await r.json()).content.sha;
  }
  function messageErreur(e) {
    if (!(e instanceof ErreurGitHub)) return "Erreur : " + (e.message || e);
    if (e.statut === 0) return "Pas de connexion à GitHub : vérifiez la connexion internet.";
    if (e.statut === 401) return "GitHub refuse le jeton : il est mal copié, supprimé ou expiré.";
    if (e.statut === 403) return "Le jeton n'a pas le droit d'écrire dans ce dépôt (il faut « Contents : Read and write »).";
    if (e.statut === 404) return "Dépôt introuvable : vérifiez le nom (pseudo/dépôt) et que le jeton a accès à ce dépôt.";
    return `GitHub a répondu ${e.statut}${e.message ? " : " + e.message : ""}.`;
  }

  /* ------------------------------------------------------------------ données */
  function normaliser(d) {
    d = d && typeof d === "object" ? d : {};
    d.format = 1;
    d.personnes = Array.isArray(d.personnes) ? d.personnes.slice(0, 2) : [];
    d.horaires = Array.isArray(d.horaires) ? d.horaires.filter((h) => h && h.id && h.qui && /^\d{4}-\d{2}-\d{2}$/.test(h.date)) : [];
    d.journal = Array.isArray(d.journal) ? d.journal : [];
    return d;
  }
  function nouveauSujet() { return "planning-" + aleatoire(18); }
  function nouveauPlanning(nom1, nom2) {
    return {
      format: 1,
      personnes: [
        { id: "p1", nom: nom1, couleur: COULEURS[0], sujet: nouveauSujet(), notifications: true },
        { id: "p2", nom: nom2, couleur: COULEURS[1], sujet: nouveauSujet(), notifications: true },
      ],
      horaires: [],
      journal: [{ le: maintenant(), par: "p1", texte: "a créé le planning" }],
    };
  }
  function ranger(d) {
    const limite = iso(ajouterJours(new Date(), -GARDER_JOURS));
    d.horaires = d.horaires.filter((h) => h.date >= limite)
      .sort((a, b) => a.date.localeCompare(b.date) || Number(b.journee) - Number(a.journee) || (a.debut || "").localeCompare(b.debut || ""));
    d.journal = d.journal.slice(0, 100);
  }
  function heuresTxt(h) {
    if (h.journee) return "toute la journée";
    return `${h.debut}–${h.fin}${h.fin <= h.debut ? " (finit le lendemain)" : ""}`;
  }
  function descr(h) {
    const pour = h.qui !== config.moi ? `pour ${personne(h.qui).nom} : ` : "";
    return `${pour}${dateTxt(h.date)} · ${heuresTxt(h)}${h.quoi ? " · " + h.quoi : ""}`;
  }

  /* Une modification : relit le fichier si besoin, applique, écrit (avec le « sha » : si l'autre a écrit entre-temps,
     GitHub refuse, on relit et on recommence, rien n'est perdu), note dans le journal, prévient l'autre. */
  async function modifier(appliquer, journal) {
    occupe++;
    try {
      for (let essai = 0; essai < 5; essai++) {
        if (essai > 0 || !donnees) {
          const f = await lireFichier();
          if (!f) throw new ErreurGitHub(404, "le fichier du planning a disparu du dépôt");
          donnees = f.donnees; sha = f.sha;
        }
        const copie = JSON.parse(JSON.stringify(donnees));
        const res = appliquer(copie);
        if (res === false) return false;
        const texte = typeof res === "string" ? res : journal.texte;
        copie.journal.unshift({ le: maintenant(), par: config.moi, texte, date: journal.date || null });
        ranger(copie);
        try {
          sha = await ecrireFichier(copie, sha, `${personne(config.moi).nom} ${texte}`);
        } catch (e) {
          if (e.conflit) continue;
          throw e;
        }
        donnees = copie;
        afficher();
        if (!journal.discret) notifier(texte, journal.date);
        return true;
      }
      throw new Error("le planning change sans arrêt, réessayez");
    } finally {
      occupe--;
    }
  }
  function adresseSite(date) {
    return location.origin + location.pathname + (date ? "?semaine=" + iso(debutSemaine(lireDate(date))) : "");
  }
  async function envoyerNotification(sujet, titre, message, date) {
    const params = new URLSearchParams({ title: titre, tags: "calendar", click: adresseSite(date) });
    const r = await fetch(`${NTFY}/${encodeURIComponent(sujet)}?${params}`, { method: "POST", body: message, cache: "no-store" });
    if (!r.ok) throw new Error("ntfy " + r.status);
  }
  function notifier(texte, date) {
    const a = autre();
    if (!a || !a.sujet || a.notifications === false) return;
    envoyerNotification(a.sujet, "Planning à deux", `${personne(config.moi).nom} ${texte}`, date)
      .catch(() => toast("Modification enregistrée, mais la notification n'a pas pu partir.", "erreur"));
  }

  /* ------------------------------------------------------------------ relecture régulière */
  async function rafraichir(premiere = false) {
    if (occupe || !config) return;
    try {
      const f = await lireFichier();
      if (!f) { etatSync("Le fichier planning.json n'est plus dans le dépôt."); return; }
      etatSync(null);
      if (f.sha === sha) return;
      const ancien = donnees;
      donnees = f.donnees; sha = f.sha;
      if (!donnees.personnes.some((p) => p.id === config.moi)) { config.moi = donnees.personnes[0].id; memoire.ecrire("config", config); }
      if (ancien && !premiere) signalerChangements(ancien);
      afficher();
    } catch (e) {
      if (e.statut === 401) {
        etatSync("GitHub refuse le jeton (expiré ?).", { texte: "Réglages", action: ouvrirReglages });
      } else if (e.statut === 0) {
        etatSync("Hors connexion : le planning n'est peut-être pas à jour.");
      } else {
        etatSync(messageErreur(e));
      }
    }
  }
  function signalerChangements(ancien) {
    const dernier = ancien.journal[0] ? ancien.journal[0].le : "";
    const nouveaux = donnees.journal.filter((j) => j.le > dernier && j.par !== config.moi);
    const plusRecent = ancien.horaires.reduce((m, h) => (h.le > m ? h.le : m), "");
    for (const h of donnees.horaires) if (h.le > plusRecent && h.par !== config.moi) eclairs.add(h.id);
    if (!nouveaux.length) return;
    const j = nouveaux[nouveaux.length - 1];
    const plus = nouveaux.length > 1 ? ` (et ${nouveaux.length - 1} autre${nouveaux.length > 2 ? "s" : ""} changement${nouveaux.length > 2 ? "s" : ""})` : "";
    toast(`${personne(j.par).nom} ${j.texte}${plus}`, "ok", j.date ? { texte: "Voir", action: () => allerA(j.date) } : null);
  }
  function allerA(date) {
    lundi = debutSemaine(lireDate(date));
    afficher();
    const jour = document.querySelector(`.jour[data-date="${date}"]`);
    if (jour) jour.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /* ------------------------------------------------------------------ affichage de la semaine */
  function afficher() {
    const dimanche = ajouterJours(lundi, 6);
    const memeMois = lundi.getMonth() === dimanche.getMonth();
    $("#titre-semaine").textContent = `Sem. ${numeroSemaine(lundi)} · ${lundi.getDate()}${memeMois ? "" : " " + MOIS_COURTS[lundi.getMonth()]}`
      + `${lundi.getFullYear() !== dimanche.getFullYear() ? " " + lundi.getFullYear() : ""} – ${dimanche.getDate()} ${MOIS_COURTS[dimanche.getMonth()]} ${dimanche.getFullYear()}`;
    const jours = $("#jours");
    if (!donnees) { jours.replaceChildren(el("p", { classe: "vide", texte: "Chargement du planning…" })); return; }
    $("#legende").replaceChildren(...donnees.personnes.map((p) => el("span", { classe: "pastille", couleur: p.couleur, texte: p.nom })));
    const auj = iso(new Date());
    const cartes = [];
    for (let i = 0; i < 7; i++) {
      const d = ajouterJours(lundi, i), date = iso(d);
      const titre = `${JOURS[d.getDay()][0].toUpperCase()}${JOURS[d.getDay()].slice(1)} ${d.getDate()} ${MOIS[d.getMonth()]}`;
      cartes.push(el("section", { classe: "jour" + (date === auj ? " aujourdhui" : ""), "data-date": date, "aria-label": titre },
        el("div", { classe: "tete-jour" }, el("span", { texte: titre }), date === auj ? el("span", { classe: "mot-aujourdhui", texte: "aujourd'hui" }) : null),
        el("div", { classe: "colonnes" }, donnees.personnes.map((p) => colonne(p, date)))));
    }
    jours.replaceChildren(...cartes);
    eclairs.clear();
  }
  function colonne(p, date) {
    const liste = donnees.horaires.filter((h) => h.qui === p.id && h.date === date);
    return el("div", { classe: "colonne", "data-personne": p.id },
      liste.map(carteHoraire),
      el("button", { type: "button", classe: "ajouter", texte: "+", title: `Ajouter un horaire pour ${p.nom}`,
        "aria-label": `Ajouter un horaire pour ${p.nom} le ${dateTxt(date)}`, onclick: () => ouvrirHoraire(null, { qui: p.id, date }) }));
  }
  function carteHoraire(h) {
    const p = personne(h.qui);
    const nouveau = seuilNouveau && h.par !== config.moi && h.le > seuilNouveau;
    return el("button", {
      type: "button", classe: "horaire" + (nouveau ? " nouveau" : "") + (eclairs.has(h.id) ? " eclair" : ""), couleur: p.couleur,
      "data-id": h.id, title: `${p.nom} — modifié par ${personne(h.par).nom} ${quandTxt(h.le)}`, onclick: () => ouvrirHoraire(h),
    },
    el("span", { classe: "heures", texte: h.journee ? "Toute la journée" : `${h.debut} – ${h.fin}` },
      !h.journee && h.fin <= h.debut ? el("span", { classe: "lendemain", texte: " (lendemain)" }) : null),
    h.quoi ? el("span", { classe: "quoi", texte: h.quoi }) : null,
    h.note ? el("span", { classe: "note", texte: h.note }) : null,
    h.serie ? el("span", { classe: "serie", texte: "🔁 chaque semaine" }) : null);
  }

  /* ------------------------------------------------------------------ fenêtres */
  function ouvrir(contenu, genre) {
    fenetre.replaceChildren(contenu);
    fenetre.dataset.genre = genre || "";
    if (!fenetre.open) fenetre.showModal();
    const premier = contenu.querySelector("[autofocus]");
    if (premier) premier.focus();
  }
  function fermer() { if (fenetre.open) fenetre.close(); }
  fenetre.addEventListener("click", (e) => { if (e.target === fenetre) fermer(); });
  function demander(titre, texte, choix) {
    return new Promise((ok) => {
      const fin = (v) => { fenetre.removeEventListener("close", annule); fermer(); ok(v); };
      const annule = () => fin(null);
      ouvrir(el("div", { classe: "contenu" }, el("h2", { texte: titre }), texte ? el("p", { texte }) : null,
        el("div", { classe: "boutons" }, choix.map((c) => el("button", {
          type: "button", classe: "bouton" + (c.classe ? " " + c.classe : ""), texte: c.texte, "data-choix": c.cle,
          onclick: () => fin(c.cle),
        })))), "question");
      fenetre.addEventListener("close", annule, { once: true });
    });
  }
  function choixPersonnes(valeur, quandChange, avecLesDeux = false) {
    const options = [...donnees.personnes.map((p) => ({ id: p.id, nom: p.nom, couleur: p.couleur }))];
    if (avecLesDeux) options.push({ id: "tous", nom: "Les deux", couleur: "#475569" });
    const zone = el("div", { classe: "choix", role: "group" });
    const maj = (v) => { for (const b of zone.children) b.classList.toggle("actif", b.dataset.id === v); };
    zone.append(...options.map((o) => el("button", {
      type: "button", "data-id": o.id, couleur: o.couleur, texte: o.nom, onclick: () => { maj(o.id); quandChange(o.id); },
    })));
    maj(valeur);
    return zone;
  }
  async function enregistrer(bouton, action) {
    const texte = bouton.textContent;
    bouton.disabled = true; bouton.textContent = "Enregistrement…";
    try {
      return await action();
    } catch (e) {
      toast(messageErreur(e), "erreur");
      return undefined;
    } finally {
      bouton.disabled = false; bouton.textContent = texte;
    }
  }

  /* ---------- ajouter / modifier un horaire */
  function ouvrirHoraire(h, defauts = {}) {
    const nouveau = !h;
    let qui = h ? h.qui : defauts.qui || config.moi;
    const date = el("input", { type: "date", id: "f-date", value: h ? h.date : defauts.date || iso(new Date()), required: true });
    const journee = el("input", { type: "checkbox", id: "f-journee", checked: h ? !!h.journee : false });
    const debut = el("input", { type: "time", id: "f-debut", value: h ? h.debut || "" : "", step: 300 });
    const fin = el("input", { type: "time", id: "f-fin", value: h ? h.fin || "" : "", step: 300 });
    const aideNuit = el("p", { classe: "aide", id: "aide-nuit" });
    const quoi = el("input", { type: "text", id: "f-quoi", value: h ? h.quoi || "" : "", maxlength: 60, list: "liste-quoi", autocomplete: "off",
      placeholder: "Travail, sport, rendez-vous…" });
    const recents = [...new Set(donnees.horaires.slice().reverse().map((x) => x.quoi).filter(Boolean))].slice(0, 12);
    const note = el("textarea", { id: "f-note", maxlength: 200, placeholder: "Facultatif" });
    note.value = h ? h.note || "" : "";
    const repeter = nouveau ? el("select", { id: "f-repeter" },
      el("option", { value: "1", texte: "Ne pas répéter" }),
      [2, 3, 4, 5, 6, 8, 10, 12].map((n) => el("option", { value: String(n), texte: `Chaque semaine, ${n} semaines de suite` }))) : null;
    const suivants = h && h.serie ? donnees.horaires.filter((x) => x.serie === h.serie && x.date > h.date) : [];
    const suite = suivants.length ? el("input", { type: "checkbox", id: "f-suite" }) : null;
    const erreur = el("p", { classe: "erreur-form", hidden: true });
    const zoneHeures = el("div", { classe: "deux" },
      el("div", { classe: "champ" }, el("label", { for: "f-debut", texte: "Début" }), debut),
      el("div", { classe: "champ" }, el("label", { for: "f-fin", texte: "Fin" }), fin));
    const majHeures = () => {
      zoneHeures.hidden = journee.checked;
      aideNuit.textContent = !journee.checked && debut.value && fin.value && fin.value < debut.value ? `Se termine le lendemain à ${fin.value}.` : "";
    };
    for (const c of [journee, debut, fin]) c.addEventListener("input", majHeures);
    majHeures();
    const boutonOk = el("button", { type: "submit", classe: "bouton principal", texte: "Enregistrer" });
    const f = el("form", { classe: "contenu", novalidate: true },
      el("h2", { texte: nouveau ? "Nouvel horaire" : "Horaire" }),
      erreur,
      el("div", { classe: "champ" }, el("span", { classe: "etiquette", texte: "Pour" }), choixPersonnes(qui, (v) => { qui = v; })),
      el("div", { classe: "champ" }, el("label", { for: "f-date", texte: "Jour" }), date),
      el("label", { classe: "case" }, journee, "Toute la journée"),
      zoneHeures, aideNuit,
      el("div", { classe: "champ" }, el("label", { for: "f-quoi", texte: "Quoi" }), quoi,
        el("datalist", { id: "liste-quoi" }, recents.map((r) => el("option", { value: r }))),
        el("div", { classe: "choix" }, SUGGESTIONS.map((s) => el("button", { type: "button", texte: s, onclick: () => { quoi.value = s; } })))),
      el("div", { classe: "champ" }, el("label", { for: "f-note", texte: "Note" }), note),
      repeter ? el("div", { classe: "champ" }, el("label", { for: "f-repeter", texte: "Répéter" }), repeter) : null,
      suite ? el("label", { classe: "case" }, suite, `Appliquer aussi aux ${suivants.length} suivant${suivants.length > 1 ? "s" : ""} de la série`) : null,
      !nouveau ? el("p", { classe: "aide", texte: `Modifié par ${personne(h.par).nom} ${quandTxt(h.le)}.` }) : null,
      el("div", { classe: "boutons" },
        !nouveau ? el("button", { type: "button", classe: "bouton danger gauche", id: "bouton-supprimer", texte: "Supprimer", onclick: () => supprimerHoraire(h) }) : null,
        el("button", { type: "button", classe: "bouton", texte: "Annuler", onclick: fermer }),
        boutonOk));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const montre = (m, champ) => { erreur.textContent = m; erreur.hidden = false; if (champ) champ.focus(); };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date.value)) return montre("Choisissez le jour.", date);
      if (!journee.checked && (!debut.value || !fin.value)) return montre("Indiquez l'heure de début et l'heure de fin (ou cochez « Toute la journée »).", debut.value ? fin : debut);
      if (!journee.checked && debut.value === fin.value) return montre("L'heure de fin est la même que l'heure de début.", fin);
      const base = {
        qui, date: date.value, journee: journee.checked, debut: journee.checked ? "" : debut.value, fin: journee.checked ? "" : fin.value,
        quoi: quoi.value.trim().slice(0, 60), note: note.value.trim().slice(0, 200),
      };
      let ok;
      if (nouveau) {
        const n = Number(repeter.value), serie = n > 1 ? nouvelId("s") : null;
        ok = await enregistrer(boutonOk, () => modifier((d) => {
          for (let i = 0; i < n; i++) {
            d.horaires.push({ id: nouvelId("h"), ...base, date: iso(ajouterJours(lireDate(base.date), 7 * i)), serie, par: config.moi, le: maintenant() });
          }
        }, { texte: `a ajouté ${descr(base)}${n > 1 ? ` (chaque semaine, ${n} semaines)` : ""}`, date: base.date }));
      } else {
        const lot = suite && suite.checked;
        const decalage = joursEntre(h.date, base.date);
        const avant = [];
        if (h.date !== base.date) avant.push(dateTxt(h.date));
        if (heuresTxt(h) !== heuresTxt(base)) avant.push(heuresTxt(h));
        if ((h.quoi || "") !== base.quoi && h.quoi) avant.push(h.quoi);
        if (h.qui !== base.qui) avant.push(personne(h.qui).nom);
        ok = await enregistrer(boutonOk, () => modifier((d) => {
          const cible = d.horaires.find((x) => x.id === h.id);
          if (!cible) return false;
          const groupe = lot ? d.horaires.filter((x) => x.serie === h.serie && x.date >= h.date) : [cible];
          for (const x of groupe) {
            Object.assign(x, { ...base, date: iso(ajouterJours(lireDate(x.date), decalage)), par: config.moi, le: maintenant() });
          }
        }, {
          texte: `a modifié ${descr(base)}${avant.length ? ` (avant : ${avant.join(", ")})` : ""}${lot ? ` et les ${suivants.length} suivants` : ""}`,
          date: base.date,
        }));
        if (ok === false) { fermer(); toast("Cet horaire a été supprimé entre-temps.", "erreur"); return; }
      }
      if (ok) { fermer(); toast(nouveau ? "Horaire ajouté." : "Horaire modifié."); }
    });
    ouvrir(f, "horaire");
    if (nouveau && matchMedia("(pointer: fine)").matches) (defauts.date ? debut : date).focus();   // pas sur téléphone : le clavier s'ouvrirait
  }
  async function supprimerHoraire(h) {
    const suivants = h.serie ? donnees.horaires.filter((x) => x.serie === h.serie && x.date > h.date) : [];
    const choix = suivants.length
      ? await demander("Supprimer l'horaire", descr(h), [
        { cle: null, texte: "Annuler" },
        { cle: "un", texte: "Seulement celui-ci", classe: "danger" },
        { cle: "suite", texte: `Celui-ci et les ${suivants.length} suivant${suivants.length > 1 ? "s" : ""}`, classe: "danger" }])
      : await demander("Supprimer cet horaire ?", descr(h), [{ cle: null, texte: "Annuler" }, { cle: "un", texte: "Supprimer", classe: "danger" }]);
    if (!choix) return;
    fermer();
    try {
      const ok = await modifier((d) => {
        const avant = d.horaires.length;
        d.horaires = d.horaires.filter((x) => !(x.id === h.id || (choix === "suite" && x.serie === h.serie && x.date > h.date)));
        if (d.horaires.length === avant) return false;
      }, { texte: `a supprimé ${descr(h)}${choix === "suite" ? ` et les ${suivants.length} suivants` : ""}`, date: h.date });
      toast(ok === false ? "Cet horaire était déjà supprimé." : "Horaire supprimé.");
    } catch (e) {
      toast(messageErreur(e), "erreur");
    }
  }

  /* ---------- copier la semaine */
  function ouvrirCopie() {
    let qui = config.moi;
    const dimanche = ajouterJours(lundi, 6);
    const combien = el("select", { id: "f-combien" },
      [1, 2, 3, 4, 6, 8].map((n) => el("option", { value: String(n), texte: n === 1 ? "la semaine suivante" : `les ${n} semaines suivantes` })));
    const boutonOk = el("button", { type: "submit", classe: "bouton principal", texte: "Copier" });
    const f = el("form", { classe: "contenu" },
      el("h2", { texte: "Copier cette semaine" }),
      el("p", { texte: `Recopie les horaires du ${dateTxt(iso(lundi))} au ${dateTxt(iso(dimanche))} sur les semaines suivantes.` }),
      el("div", { classe: "champ" }, el("span", { classe: "etiquette", texte: "Les horaires de" }), choixPersonnes(qui, (v) => { qui = v; }, true)),
      el("div", { classe: "champ" }, el("label", { for: "f-combien", texte: "Vers" }), combien),
      el("p", { classe: "aide", texte: "Un horaire déjà présent à l'identique n'est pas doublé." }),
      el("div", { classe: "boutons" }, el("button", { type: "button", classe: "bouton", texte: "Annuler", onclick: fermer }), boutonOk));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const n = Number(combien.value), du = iso(lundi), au = iso(dimanche);
      let raison = "";
      const ok = await enregistrer(boutonOk, () => modifier((d) => {
        const source = d.horaires.filter((x) => x.date >= du && x.date <= au && (qui === "tous" || x.qui === qui));
        if (!source.length) { raison = "Rien à copier cette semaine."; return false; }
        let ajoutes = 0;
        for (let k = 1; k <= n; k++) {
          for (const x of source) {
            const nd = iso(ajouterJours(lireDate(x.date), 7 * k));
            const existe = d.horaires.some((y) => y.qui === x.qui && y.date === nd && y.journee === x.journee && y.debut === x.debut && y.fin === x.fin && (y.quoi || "") === (x.quoi || ""));
            if (!existe) { d.horaires.push({ ...x, id: nouvelId("h"), date: nd, serie: null, par: config.moi, le: maintenant() }); ajoutes++; }
          }
        }
        if (!ajoutes) { raison = "Ces horaires sont déjà copiés."; return false; }
        const quiTxt = qui === "tous" ? "de tout le monde" : qui === config.moi ? "" : `de ${personne(qui).nom}`;
        return `a copié la semaine du ${dateTxt(du)}${quiTxt ? " " + quiTxt : ""} sur ${n === 1 ? "la semaine suivante" : `les ${n} semaines suivantes`} (${ajoutes} horaire${ajoutes > 1 ? "s" : ""})`;
      }, { date: iso(ajouterJours(lundi, 7)) }));
      if (ok === false) { toast(raison, "erreur"); return; }
      if (ok) { fermer(); toast("Semaine copiée."); }
    });
    ouvrir(f, "copie");
  }

  /* ---------- historique */
  function ouvrirHistorique() {
    const liste = donnees.journal.length
      ? el("ul", { classe: "historique" }, donnees.journal.map((j) => el("li", {},
        el("button", { type: "button", onclick: () => { if (j.date) { fermer(); allerA(j.date); } } },
          el("span", { classe: "quand", texte: quandTxt(j.le) }), el("br"),
          el("span", { classe: "qui", couleur: personne(j.par).couleur, texte: personne(j.par).nom }), " ", j.texte))))
      : el("p", { classe: "vide", texte: "Aucune modification pour l'instant." });
    ouvrir(el("div", { classe: "contenu" }, el("h2", { texte: "Dernières modifications" }), liste,
      el("p", { classe: "aide", texte: "Les 100 dernières modifications. Touchez une ligne pour aller à la semaine concernée." }),
      el("div", { classe: "boutons" }, el("button", { type: "button", classe: "bouton principal", texte: "Fermer", onclick: fermer }))), "historique");
  }

  /* ---------- réglages */
  function ouvrirReglages() {
    if (!donnees) return;
    const moi = personne(config.moi), lui = autre();
    let quiSuisJe = config.moi;
    const noms = {}, couleurs = {};
    const lignesPersonnes = donnees.personnes.map((p) => {
      couleurs[p.id] = p.couleur;
      noms[p.id] = el("input", { type: "text", id: `f-nom-${p.id}`, value: p.nom, maxlength: 30, required: true });
      const zone = el("div", { classe: "couleurs" });
      const maj = () => { for (const b of zone.children) b.classList.toggle("actif", b.dataset.c === couleurs[p.id]); };
      zone.append(...COULEURS.map((c) => el("button", { type: "button", couleur: c, "data-c": c, "aria-label": "Couleur " + c, onclick: () => { couleurs[p.id] = c; maj(); } })));
      maj();
      return el("div", { classe: "champ" }, el("label", { for: `f-nom-${p.id}`, texte: p.id === "p1" ? "Personne 1" : "Personne 2" }), noms[p.id], zone);
    });
    const recevoir = el("input", { type: "checkbox", id: "f-recevoir", checked: moi.notifications !== false });
    const zoneInvitation = el("div", { id: "zone-invitation" });
    const nouveauJeton = el("input", { type: "password", id: "f-nouveau-jeton", autocomplete: "off", placeholder: "github_pat_…" });
    const boutonOk = el("button", { type: "submit", classe: "bouton principal", texte: "Enregistrer" });
    const f = el("form", { classe: "contenu" },
      el("h2", { texte: "Réglages" }),
      el("div", { classe: "champ" }, el("span", { classe: "etiquette", texte: "Sur cet appareil, je suis" }),
        choixPersonnes(quiSuisJe, (v) => { quiSuisJe = v; })),
      el("h3", { texte: "Prénoms et couleurs" }),
      lignesPersonnes,

      el("h3", { texte: "Notifications sur mon téléphone" }),
      el("p", { texte: `Pour être prévenu(e) quand ${lui.nom} modifie le planning :` }),
      el("ol", { classe: "etapes" },
        el("li", {}, "Installez l'appli gratuite ntfy : ",
          el("a", { href: LIEN_NTFY_IOS, target: "_blank", rel: "noopener", texte: "iPhone" }), " · ",
          el("a", { href: LIEN_NTFY_ANDROID, target: "_blank", rel: "noopener", texte: "Android" }), "."),
        el("li", {}, "Dans ntfy, touchez « + », collez ce nom de sujet, puis « Subscribe » :",
          el("div", { classe: "ligne-copie" }, el("span", { classe: "code", id: "mon-sujet", texte: moi.sujet }),
            el("button", { type: "button", classe: "bouton petit", texte: "Copier", onclick: () => copier(moi.sujet) }))),
        el("li", {}, "Vérifiez : ",
          el("button", { type: "button", classe: "bouton petit", id: "bouton-test-notif", texte: "M'envoyer une notification de test",
            onclick: () => envoyerNotification(moi.sujet, "Planning à deux", "Notification de test : tout marche !", null)
              .then(() => toast("Notification envoyée : elle doit arriver sur votre téléphone."))
              .catch(() => toast("La notification n'a pas pu partir (connexion ?).", "erreur")) }))),
      el("label", { classe: "case" }, recevoir, `Me prévenir quand ${lui.nom} modifie le planning`),
      el("p", { classe: "aide", texte: "Ce nom de sujet est secret : ne le partagez pas, ceux qui le connaissent verraient les notifications." }),

      el("h3", { texte: `Inviter ${lui.nom}` }),
      el("p", { texte: `${lui.nom} ouvre ce lien sur son téléphone : il connecte son appareil au planning, sans compte GitHub.` }),
      el("button", { type: "button", classe: "bouton", id: "bouton-invitation", texte: "Créer le lien d'invitation",
        onclick: () => montrerInvitation(zoneInvitation, lui) }),
      zoneInvitation,

      el("h3", { texte: "Connexion à GitHub" }),
      el("p", { classe: "aide" }, "Dépôt des données : ", el("strong", { texte: config.depot }),
        config.jeton_le ? `. Jeton enregistré le ${dateTxt(config.jeton_le)} ${config.jeton_le.slice(0, 4)}.` : "."),
      el("div", { classe: "champ" }, el("label", { for: "f-nouveau-jeton", texte: "Remplacer le jeton (s'il a expiré)" }), nouveauJeton,
        el("p", { classe: "aide" }, el("a", { href: LIEN_JETON, target: "_blank", rel: "noopener", texte: "Créer un nouveau jeton sur GitHub" }),
          " (choisir « Only select repositories » puis le dépôt des données).")),
      el("button", { type: "button", classe: "bouton danger", id: "bouton-deconnecter", texte: "Déconnecter cet appareil",
        onclick: async () => {
          const c = await demander("Déconnecter cet appareil ?", "Le planning reste sur GitHub ; il faudra se reconnecter (ou rouvrir un lien d'invitation).",
            [{ cle: null, texte: "Annuler" }, { cle: "oui", texte: "Déconnecter", classe: "danger" }]);
          if (c) { memoire.effacer("config"); location.replace(location.pathname); }
        } }),
      el("div", { classe: "boutons" }, el("button", { type: "button", classe: "bouton", texte: "Fermer", onclick: fermer }), boutonOk));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      for (const p of donnees.personnes) if (!noms[p.id].value.trim()) { toast("Indiquez les deux prénoms.", "erreur"); noms[p.id].focus(); return; }
      const jeton = nouveauJeton.value.trim();
      if (jeton) {
        const ok = await enregistrer(boutonOk, async () => { await lireFichier(jeton); return true; });
        if (!ok) return;
        config.jeton = jeton; config.jeton_le = iso(new Date());
      }
      if (quiSuisJe !== config.moi) { config.moi = quiSuisJe; }
      memoire.ecrire("config", config);
      const change = donnees.personnes.some((p) => p.nom !== noms[p.id].value.trim() || p.couleur !== couleurs[p.id])
        || (personne(config.moi).notifications !== false) !== recevoir.checked;
      const choixRecevoir = recevoir.checked, pour = config.moi;
      if (change) {
        const ok = await enregistrer(boutonOk, () => modifier((d) => {
          for (const p of d.personnes) {
            p.nom = noms[p.id].value.trim().slice(0, 30); p.couleur = couleurs[p.id];
            if (p.id === pour) p.notifications = choixRecevoir;
          }
        }, { texte: "a changé les réglages", discret: true }));
        if (!ok) return;
      }
      fermer();
      afficher();
      toast(jeton ? `Réglages enregistrés. Envoyez un nouveau lien d'invitation à ${autre().nom} : l'ancien jeton ne marche plus chez elle/lui.` : "Réglages enregistrés.");
    });
    ouvrir(f, "reglages");
  }
  function lienInvitation(pour) {
    const charge = { v: 1, d: config.depot, j: config.jeton, m: pour.id, le: config.jeton_le || null };
    return location.origin + location.pathname + "#invitation=" + vers64(JSON.stringify(charge)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function montrerInvitation(zone, pour) {
    const lien = lienInvitation(pour);
    zone.replaceChildren(
      el("div", { classe: "ligne-copie" }, el("span", { classe: "code", id: "lien-invitation", texte: lien }),
        el("button", { type: "button", classe: "bouton petit", texte: "Copier", onclick: () => copier(lien) }),
        navigator.share ? el("button", { type: "button", classe: "bouton petit", texte: "Envoyer…",
          onclick: () => navigator.share({ title: "Planning à deux", text: "Le lien pour notre planning partagé :", url: lien }).catch(() => {}) }) : null),
      el("p", { classe: "aide alerte", texte: `Ce lien donne accès au planning : envoyez-le seulement à ${pour.nom}.` }));
  }
  function lireInvitation(code) {
    try {
      const b = code.replace(/-/g, "+").replace(/_/g, "/");
      const c = JSON.parse(depuis64(b + "=".repeat((4 - (b.length % 4)) % 4)));
      return c && c.d && c.j ? c : null;
    } catch {
      return null;
    }
  }

  /* ------------------------------------------------------------------ première connexion */
  const accueil = $("#accueil");
  function pageAccueil(...contenu) {
    document.body.classList.add("sans-planning");
    accueil.hidden = false;
    accueil.replaceChildren(el("div", { classe: "carte" }, el("h1", { texte: "Planning à deux" }), ...contenu));
    const premier = accueil.querySelector("input");
    if (premier) premier.focus();
  }
  function accueilConnexion(message) {
    const depot = el("input", { type: "text", id: "f-depot", placeholder: "pseudo/planning-a-deux-donnees", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
    const jeton = el("input", { type: "password", id: "f-jeton", placeholder: "github_pat_…", autocomplete: "off" });
    const erreur = el("p", { classe: "erreur-form", hidden: !message, texte: message || "" });
    const bouton = el("button", { type: "submit", classe: "bouton principal", texte: "Se connecter" });
    const f = el("form", {},
      el("p", { texte: "Connectez ce site au dépôt GitHub privé où seront gardés vos horaires (voir le guide)." }),
      erreur,
      el("div", { classe: "champ" }, el("label", { for: "f-depot", texte: "Dépôt des données" }), depot,
        el("p", { classe: "aide", texte: "Votre pseudo GitHub, une barre /, puis le nom du dépôt privé." })),
      el("div", { classe: "champ" }, el("label", { for: "f-jeton", texte: "Jeton GitHub" }), jeton,
        el("p", { classe: "aide" }, el("a", { href: LIEN_JETON, target: "_blank", rel: "noopener", texte: "Créer le jeton sur GitHub" }),
          " : choisissez « Only select repositories » puis le dépôt des données ; le reste est déjà rempli.")),
      el("div", { classe: "boutons" }, bouton));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const d = depot.value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
      const j = jeton.value.trim();
      erreur.hidden = true;
      if (!/^[\w.-]+\/[\w.-]+$/.test(d)) { erreur.textContent = "Écrivez le dépôt sous la forme pseudo/nom-du-depot."; erreur.hidden = false; depot.focus(); return; }
      if (!j) { erreur.textContent = "Collez le jeton GitHub."; erreur.hidden = false; jeton.focus(); return; }
      bouton.disabled = true; bouton.textContent = "Connexion…";
      try {
        await verifierDepot(j, d);
        const f2 = await lireFichier(j, d);
        if (f2) accueilQuiEsTu({ depot: d, jeton: j, jeton_le: iso(new Date()) }, f2);
        else accueilCreation({ depot: d, jeton: j, jeton_le: iso(new Date()) });
      } catch (err) {
        erreur.textContent = messageErreur(err); erreur.hidden = false;
        bouton.disabled = false; bouton.textContent = "Se connecter";
      }
    });
    pageAccueil(f);
  }
  function accueilCreation(c) {
    const nom1 = el("input", { type: "text", id: "f-prenom-moi", maxlength: 30, autocomplete: "given-name" });
    const nom2 = el("input", { type: "text", id: "f-prenom-autre", maxlength: 30 });
    const erreur = el("p", { classe: "erreur-form", hidden: true });
    const bouton = el("button", { type: "submit", classe: "bouton principal", texte: "Créer le planning" });
    const f = el("form", {},
      el("p", { texte: "Connexion réussie. Le dépôt est vide : créons votre planning." }),
      erreur,
      el("div", { classe: "champ" }, el("label", { for: "f-prenom-moi", texte: "Votre prénom" }), nom1),
      el("div", { classe: "champ" }, el("label", { for: "f-prenom-autre", texte: "Le prénom de l'autre personne" }), nom2),
      el("div", { classe: "boutons" }, bouton));
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!nom1.value.trim() || !nom2.value.trim()) { erreur.textContent = "Indiquez les deux prénoms."; erreur.hidden = false; return; }
      bouton.disabled = true; bouton.textContent = "Création…";
      try {
        const d = nouveauPlanning(nom1.value.trim().slice(0, 30), nom2.value.trim().slice(0, 30));
        sha = await ecrireFichier(d, null, "Création du planning", c.jeton, c.depot);
        donnees = d;
        config = { ...c, moi: "p1" };
        memoire.ecrire("config", config);
        lancer(true);
        toast("Planning créé ! Ouvrez ⚙️ Réglages pour activer les notifications et inviter " + d.personnes[1].nom + ".", "ok",
          { texte: "Réglages", action: ouvrirReglages });
      } catch (err) {
        erreur.textContent = messageErreur(err); erreur.hidden = false;
        bouton.disabled = false; bouton.textContent = "Créer le planning";
      }
    });
    pageAccueil(f);
  }
  function accueilQuiEsTu(c, f, invitation = null) {
    const d = f.donnees;
    const proposition = invitation && d.personnes.find((p) => p.id === invitation.m);
    const choisir = (p) => {
      config = { ...c, moi: p.id };
      memoire.ecrire("config", config);
      donnees = d; sha = f.sha;
      lancer(true);
      toast(`Bienvenue ${p.nom} ! Pour être prévenu(e) des modifications, activez les notifications.`, "ok", { texte: "Réglages", action: ouvrirReglages });
    };
    const personnes = proposition ? [proposition, ...d.personnes.filter((p) => p !== proposition)] : d.personnes;
    pageAccueil(
      el("p", { texte: invitation ? "Vous êtes invité(e) sur le planning partagé." : "Connexion réussie." }),
      el("p", { classe: "etiquette", texte: "Qui êtes-vous ?" }),
      el("div", { classe: "boutons" }, personnes.map((p, i) => el("button", {
        type: "button", classe: "bouton" + (i === 0 ? " principal" : ""), "data-id": p.id, texte: `Je suis ${p.nom}`, onclick: () => choisir(p),
      }))));
  }
  async function accueilInvitation(inv) {
    pageAccueil(el("p", { texte: "Connexion au planning partagé…" }));
    try {
      const f = await lireFichier(inv.j, inv.d);
      if (!f) throw new ErreurGitHub(404, "le planning n'existe pas encore");
      accueilQuiEsTu({ depot: inv.d, jeton: inv.j, jeton_le: inv.le || null }, f, inv);
    } catch (e) {
      pageAccueil(el("p", { classe: "erreur-form", texte: "Ce lien d'invitation ne marche pas : " + messageErreur(e) }),
        el("p", { texte: "Demandez un nouveau lien (⚙️ Réglages > Inviter) à la personne qui a créé le planning." }));
    }
  }

  /* ------------------------------------------------------------------ lancement */
  let lance = false;
  function lancer(dejaCharge = false) {
    document.body.classList.remove("sans-planning");
    accueil.hidden = true;
    seuilNouveau = memoire.lire("vu");
    afficher();
    if (!dejaCharge) rafraichir(true);
    if (lance) return;
    lance = true;
    $("#semaine-avant").addEventListener("click", () => { lundi = ajouterJours(lundi, -7); afficher(); });
    $("#semaine-apres").addEventListener("click", () => { lundi = ajouterJours(lundi, 7); afficher(); });
    $("#bouton-aujourdhui").addEventListener("click", () => allerA(iso(new Date())));
    $("#bouton-copier").addEventListener("click", () => donnees && ouvrirCopie());
    $("#bouton-historique").addEventListener("click", () => donnees && ouvrirHistorique());
    $("#bouton-reglages").addEventListener("click", ouvrirReglages);
    setInterval(() => { if (!document.hidden && !fenetre.open) rafraichir(); }, ATTENTE);
    const parti = () => memoire.ecrire("vu", maintenant());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { parti(); return; }
      seuilNouveau = memoire.lire("vu");
      rafraichir();
    });
    window.addEventListener("pagehide", parti);
    if (config.jeton_le && joursEntre(config.jeton_le, iso(new Date())) > 350) {
      toast("Le jeton GitHub a presque un an : s'il a été créé pour un an, remplacez-le bientôt (⚙️ Réglages).", "ok",
        { texte: "Réglages", action: ouvrirReglages });
    }
  }
  function demarrer() {
    const params = new URLSearchParams(location.search);
    const semaine = params.get("semaine");
    if (semaine && /^\d{4}-\d{2}-\d{2}$/.test(semaine)) lundi = debutSemaine(lireDate(semaine));
    const invitation = location.hash.startsWith("#invitation=") ? lireInvitation(location.hash.slice(12)) : null;
    if (location.search || location.hash) history.replaceState(null, "", location.pathname);   // le lien ne reste pas dans la barre
    if (invitation) return accueilInvitation(invitation);
    if (!config || !config.depot || !config.jeton || !config.moi) return accueilConnexion();
    lancer();
  }
  demarrer();
})();
