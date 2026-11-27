/*
 * grist-annuaire – tenir à jour les personnes et les structures d'un document Grist, widget-outil au DSFR.
 *
 * L'annuaire n'a pas de base à lui : il gère les tables Personnes et Structures du document où il est
 * posé, que les autres widgets lisent aussi. Il les reprend telles qu'elles sont (y compris quand une
 * autre application les a créées) et n'ajoute que des colonnes : rien n'est renommé, converti ni supprimé.
 *
 * Fonctions : recherche et filtres, fiches, arborescence des structures, champs personnalisés,
 * doublons et fusion, import d'un fichier CSV, « apparaît dans », export et suppression d'une fiche,
 * archivage et purge, rôle « gestionnaire de l'annuaire » appliqué par les règles d'accès de Grist.
 *
 * Hors de Grist (page ouverte directement), il charge des données fictives et simule les écritures.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constantes et réglages
  // ---------------------------------------------------------------------------

  var NOM_COLONNE_CONFIG = 'Config_annuaire';
  var ATTRIBUT = 'Profil_annuaire';      // attribut utilisateur des règles d'accès
  var PAR_PAGE = 50;
  var DEFAUTS = { typesStructure: ['Établissement', 'Service', 'Équipe', 'Collectivité', 'Association', 'Entreprise', 'Autre'] };
  var MENTION_DEFAUT = 'Les données de cet annuaire (nom, courriel et coordonnées professionnels, structure, fonction) servent à faciliter le travail en commun. ' +
    'Elles sont visibles des seules personnes invitées dans ce document. Elles sont conservées tant que la personne participe, puis supprimées au plus tard 12 mois après son archivage. ' +
    'Pour accéder à vos données, les corriger ou les faire effacer, adressez-vous aux gestionnaires de l\'annuaire.';
  // Champs prévus : [clé, libellé, colonne, actif par défaut]
  var CHAMPS_PREVUS = [
    ['fonction', 'Fonction', 'Fonction', true],
    ['telephoneFixe', 'Téléphone fixe professionnel', 'Telephone_fixe', false],
    ['telephonePortable', 'Téléphone portable professionnel', 'Telephone_portable', false]
  ];
  // Types des champs personnalisés : [clé, libellé, type Grist]
  var TYPES_PERSO = [['texte', 'Texte court', 'Text'], ['texteLong', 'Texte long', 'Text'], ['choix', 'Choix dans une liste', 'Choice'],
    ['choixMultiple', 'Plusieurs choix dans une liste', 'ChoiceList'], ['date', 'Date', 'Date'], ['nombre', 'Nombre', 'Numeric'], ['case', 'Case à cocher', 'Bool']];
  // Colonnes de texte connues des autres outils où un nom de personne peut être écrit.
  var MENTIONS_TEXTE = { Actions_reunion: ['Responsable'], Reunions: ['Participants', 'Excuses', 'Animation', 'Secretariat'], Points: ['Porteur'], Liens: ['De', 'Vers'] };
  var NOMS_TABLES = { Projets: 'Projets', Actions: 'Actions de projet', Actions_reunion: 'Actions de réunion', Reunions: 'Réunions', Points: 'Points de réunion',
    Groupes: 'Groupes', Comptes: 'Comptes Grist', Liens: 'Liens du graphe', Journal: 'Journal des projets', Documents: 'Documents des projets', Signalements: 'Signalements', Structures: 'Structures' };

  var reglages = {}, R = {};
  function appliquerReglages(r) {
    reglages = r || {};
    R = {
      champs: {},
      perso: Array.isArray(reglages.champsPerso) ? reglages.champsPerso.filter(function (c) { return c && c.col; }) : [],
      typesStructure: Array.isArray(reglages.listes && reglages.listes.typesStructure) && reglages.listes.typesStructure.length ? reglages.listes.typesStructure : null,
      purgeMois: reglages.purgeMois === 0 ? 0 : (Number(reglages.purgeMois) > 0 ? Number(reglages.purgeMois) : 12),
      mention: typeof reglages.mention === 'string' ? reglages.mention : MENTION_DEFAUT,
      ignores: Array.isArray(reglages.pasDoublons) ? reglages.pasDoublons : []
    };
    CHAMPS_PREVUS.forEach(function (c) { var v = (reglages.champs || {})[c[0]]; R.champs[c[0]] = v === undefined ? c[3] : !!v; });
    var page = Object.assign({ marque: '', titre: 'Annuaire', pied: { accessibilite: '' } }, reglages.page || {});
    if (window.PageDSFR) {
      var cible = window.PageDSFR.appliquer(page, { entete: document.getElementById('entete'), pied: document.getElementById('pied'), accueil: '#/' });
      cible.entete.id = 'entete';
      cible.pied.id = 'pied';
    }
  }
  function typesStructure() {
    if (R.typesStructure) return R.typesStructure;
    var c = col('Structures', 'Type'), o = {};
    try { o = JSON.parse((c && c.widgetOptions) || '{}'); } catch (e) { o = {}; }
    return Array.isArray(o.choices) && o.choices.length ? o.choices : DEFAUTS.typesStructure;
  }

  // ---------------------------------------------------------------------------
  // État
  // ---------------------------------------------------------------------------

  var DEMO = window.self === window.top;
  var meta = { tables: [], colonnes: [] };
  var data = { Personnes: [], Structures: [], Comptes: null }, idx = { Personnes: {}, Structures: {} };
  var autres = {};          // lignes des autres tables qui citent des personnes ou des structures : { table: [lignes] }
  var moi = { email: '', verifie: false };
  var etat = {
    alerte: null,
    f: { q: '', structure: '', fonction: '', statut: 'actives', sansCourriel: false, gestion: false, perso: {} },
    page: 0, tri: 'nom',
    brouillons: {},
    imp: null,                 // import en cours
    confirmation: null,        // { type, ids } suppression à confirmer
    apresFusion: null,
    rendreApresSaisie: false
  };
  var app = document.getElementById('an-app');

  // ---------------------------------------------------------------------------
  // Utilitaires
  // ---------------------------------------------------------------------------

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  function sansAccents(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function cleNom(s) { return sansAccents(s).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' '); }
  function courrielValide(s) { return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(String(s || '')); }
  function liste(v) { return Array.isArray(v) ? (v[0] === 'L' ? v.slice(1) : v) : (v === null || v === undefined || v === '' ? [] : [v]); }
  function lignesDepuisColonnes(cols) {
    var ids = cols.id || [], cles = Object.keys(cols), res = [];
    for (var i = 0; i < ids.length; i++) { var l = {}; cles.forEach(function (k) { l[k] = cols[k][i]; }); res.push(l); }
    return res;
  }
  function aujourdhui() { var d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 1000; }
  function dateTexte(sec) { return sec ? new Date(sec * 1000).toLocaleDateString('fr-FR', { timeZone: 'UTC' }) : ''; }
  function dateVersSaisie(sec) { return sec ? new Date(sec * 1000).toISOString().slice(0, 10) : ''; }
  function saisieVersDate(txt) { var p = String(txt || '').split('-'); return p.length === 3 ? Date.UTC(+p[0], +p[1] - 1, +p[2]) / 1000 : null; }
  function badge(texte, couleur) {
    return '<span class="fr-badge fr-badge--sm fr-badge--no-icon' + (couleur ? ' fr-badge--' + couleur : '') + '">' + esc(texte) + '</span>';
  }
  function brouillon(cle) { return (etat.brouillons[cle] = etat.brouillons[cle] || {}); }

  // ---------------------------------------------------------------------------
  // Méta-données du document
  // ---------------------------------------------------------------------------

  function table(t) { return meta.tables.filter(function (x) { return x.tableId === t; })[0]; }
  function col(t, c) { var tb = table(t); return tb && meta.colonnes.filter(function (x) { return x.parentId === tb.id && x.colId === c; })[0]; }
  function aCol(t, c) { return !!col(t, c); }
  function colonnesDe(t) { var tb = table(t); return tb ? meta.colonnes.filter(function (x) { return x.parentId === tb.id && !/^gristHelper_/.test(x.colId) && x.colId !== 'manualSort'; }) : []; }
  function tablesUtilisateur() { return meta.tables.filter(function (t) { return !/^_grist/.test(t.tableId) && !t.summarySourceTable; }); }
  // Colonne où écrire le courriel : Email si c'est une donnée, Email_saisi si Email est une formule (variante grist-projet).
  function colCourriel() {
    var c = col('Personnes', 'Email');
    if (c && c.isFormula && c.formula) return aCol('Personnes', 'Email_saisi') ? 'Email_saisi' : null;
    return c ? 'Email' : null;
  }
  function colonnesManquantes() {
    var m = [];
    if (!table('Structures')) m.push('table Structures');
    ['Fonction', 'Archive', 'Archive_le', 'Fusionne_dans', 'Gestion_annuaire', 'Cree_par'].forEach(function (c) { if (!aCol('Personnes', c)) m.push('Personnes.' + c); });
    if (!colCourriel() && !aCol('Personnes', 'Email')) m.push('Personnes.Email');
    if (!aCol('Personnes', 'Structure')) m.push('Personnes.Structure');
    ['Sigle', 'Type', 'Parent', 'Adresse', 'Courriel', 'Site'].forEach(function (c) { if (table('Structures') && !aCol('Structures', c)) m.push('Structures.' + c); });
    return m;
  }
  function champsActifs() {
    var res = CHAMPS_PREVUS.filter(function (c) { return R.champs[c[0]] && aCol('Personnes', c[2]); }).map(function (c) { return { col: c[2], libelle: c[1], type: 'texte' }; });
    return res.concat(R.perso.filter(function (c) { return !c.masque && aCol('Personnes', c.col); }));
  }

  // ---------------------------------------------------------------------------
  // Données de démonstration
  // ---------------------------------------------------------------------------

  var SCHEMA_DEMO = {
    Structures: { Nom: 'Text', Sigle: 'Text', Type: 'Choice', Parent: 'Ref:Structures', Adresse: 'Text', Courriel: 'Text', Site: 'Text' },
    Personnes: { Nom: 'Text', Email: 'Text', Structure: 'Ref:Structures', Fonction: 'Text', Telephone_fixe: 'Text', Telephone_portable: 'Text', Competences: 'ChoiceList',
      Archive: 'Bool', Archive_le: 'Date', Fusionne_dans: 'Ref:Personnes', Gestion_annuaire: 'Bool', Cree_par: 'Text', Config_annuaire: 'Text' },
    Projets: { Titre: 'Text', Porteurs: 'RefList:Personnes', Structure: 'Ref:Structures' },
    Groupes: { Nom: 'Text', Animation: 'Ref:Personnes', Membres: 'RefList:Personnes' },
    Actions_reunion: { Intitule: 'Text', Responsable: 'Text' }
  };
  function metaDemo() {
    var tid = 0, cid = 0;
    meta.tables = []; meta.colonnes = [];
    Object.keys(SCHEMA_DEMO).forEach(function (t) {
      var id = ++tid; meta.tables.push({ id: id, tableId: t });
      Object.keys(SCHEMA_DEMO[t]).forEach(function (c) {
        meta.colonnes.push({ id: ++cid, parentId: id, colId: c, type: SCHEMA_DEMO[t][c], isFormula: false, formula: '',
          widgetOptions: c === 'Type' ? JSON.stringify({ choices: DEFAUTS.typesStructure }) : (c === 'Competences' ? JSON.stringify({ choices: ['Animation', 'Facilitation', 'Données', 'Design', 'Juridique'] }) : '') });
      });
    });
  }
  function chargerDemo() {
    metaDemo();
    appliquerReglages({ page: { titre: 'Annuaire', sousTitre: 'Démonstration' }, champs: { telephoneFixe: true, telephonePortable: true },
      champsPerso: [{ col: 'Competences', libelle: 'Compétences', type: 'choixMultiple', options: ['Animation', 'Facilitation', 'Données', 'Design', 'Juridique'] }] });
    return fetch('exemples/demo.json').then(function (r) { return r.json(); }).then(function (json) {
      data.Structures = json.Structures; data.Personnes = json.Personnes;
      autres = { Projets: json.Projets, Groupes: json.Groupes, Actions_reunion: json.Actions_reunion };
      data.Comptes = [{ id: 1, Email: 'camille.martin@exemple.fr' }];
      moi.email = 'camille.martin@exemple.fr'; moi.verifie = true;
    });
  }

  // ---------------------------------------------------------------------------
  // Chargement depuis Grist
  // ---------------------------------------------------------------------------

  function chargerGrist() {
    return Promise.all([grist.docApi.fetchTable('_grist_Tables'), grist.docApi.fetchTable('_grist_Tables_column')]).then(function (m) {
      meta.tables = lignesDepuisColonnes(m[0]); meta.colonnes = lignesDepuisColonnes(m[1]);
      var c = col('Personnes', NOM_COLONNE_CONFIG), r = {};
      try { r = c && c.description ? JSON.parse(c.description) : {}; } catch (e) { r = {}; }
      appliquerReglages(r);
      var lire = function (t) { return table(t) ? grist.docApi.fetchTable(t).then(lignesDepuisColonnes).catch(function () { return []; }) : Promise.resolve(null); };
      // Autres tables qui citent des personnes ou des structures (références ou noms en texte).
      var cibles = {};
      tablesUtilisateur().forEach(function (t) {
        if (t.tableId === 'Personnes' || t.tableId === 'Structures') return;
        colonnesDe(t.tableId).forEach(function (x) {
          if (/^(Ref|RefList):(Personnes|Structures)$/.test(x.type)) cibles[t.tableId] = 1;
        });
      });
      Object.keys(MENTIONS_TEXTE).forEach(function (t) { if (table(t)) cibles[t] = 1; });
      var noms = Object.keys(cibles);
      return Promise.all([lire('Personnes'), lire('Structures'), lire('Comptes')].concat(noms.map(lire))).then(function (res) {
        data.Personnes = res[0] || []; data.Structures = res[1] || []; data.Comptes = res[2];
        autres = {}; noms.forEach(function (t, i) { autres[t] = res[3 + i] || []; });
      });
    });
  }

  function charger() { return (DEMO ? chargerDemo() : chargerGrist()).then(indexer); }
  function indexer() {
    idx = { Personnes: {}, Structures: {} };
    data.Personnes.forEach(function (p) { idx.Personnes[p.id] = p; });
    data.Structures.forEach(function (s) { idx.Structures[s.id] = s; });
  }

  // ---------------------------------------------------------------------------
  // Personnes et structures
  // ---------------------------------------------------------------------------

  function emailDe(p) { return String((p && (p.Email || p.Email_saisi)) || '').trim().toLowerCase(); }
  function archivee(p) { return !!p.Archive; }
  function nomStructure(id) { var s = idx.Structures[num(id)]; return s ? (s.Sigle ? s.Sigle + ' – ' + s.Nom : s.Nom) || 'Sans nom' : ''; }
  function cheminStructure(id) {
    var parts = [], s = idx.Structures[num(id)], vus = {};
    while (s && !vus[s.id] && parts.length < 8) { vus[s.id] = 1; parts.unshift(s.Sigle || s.Nom || 'Sans nom'); s = aCol('Structures', 'Parent') ? idx.Structures[num(s.Parent)] : null; }
    return parts.join(' › ');
  }
  function nomsChaine(id) {
    var parts = [], s = idx.Structures[num(id)], vus = {};
    while (s && !vus[s.id] && parts.length < 8) { vus[s.id] = 1; parts.push(s.Nom || ''); s = idx.Structures[num(s.Parent)]; }
    return parts.join(' ');
  }
  function enfants(id) { return data.Structures.filter(function (s) { return num(s.Parent) === num(id) && s.id !== num(id); }); }
  function descendants(id) {
    var res = {}, pile = [num(id)];
    while (pile.length) { var x = pile.pop(); if (res[x]) continue; res[x] = 1; enfants(x).forEach(function (e) { pile.push(e.id); }); }
    return res;
  }
  function structuresTriees() {
    // Ordre de l'arborescence, pour les listes déroulantes.
    var res = [], vus = {};
    function parcourir(s, n) { if (vus[s.id]) return; vus[s.id] = 1; res.push({ s: s, niveau: n }); enfants(s.id).sort(triNom).forEach(function (e) { parcourir(e, n + 1); }); }
    data.Structures.filter(function (s) { return !num(s.Parent) || !idx.Structures[num(s.Parent)]; }).sort(triNom).forEach(function (s) { parcourir(s, 0); });
    data.Structures.forEach(function (s) { if (!vus[s.id]) parcourir(s, 0); });
    return res;
  }
  function triNom(a, b) { return String(a.Nom || '').localeCompare(String(b.Nom || ''), 'fr'); }
  function membres(sid, avecSous) {
    var ens = avecSous ? descendants(sid) : (function () { var o = {}; o[num(sid)] = 1; return o; })();
    return data.Personnes.filter(function (p) { return ens[num(p.Structure)] && !archivee(p); });
  }
  function personneDe(email) {
    email = String(email || '').toLowerCase();
    return email ? data.Personnes.filter(function (p) { return emailDe(p) === email && !archivee(p); })[0] || data.Personnes.filter(function (p) { return emailDe(p) === email; })[0] : null;
  }

  // Lignes des autres tables qui citent une personne (références) ou son nom (texte).
  function libelleLigne(t, l) { return l.Titre || l.Intitule || l.Nom || l.Libelle || l.Sujet || ('ligne ' + l.id); }
  function apparitions(pid, type) {
    type = type || 'Personnes';
    var p = idx[type][pid], res = [];
    Object.keys(autres).forEach(function (t) {
      colonnesDe(t).forEach(function (c) {
        var m = c.type.match(/^(Ref|RefList):(\w+)$/);
        if (!m || m[2] !== type) return;
        (autres[t] || []).forEach(function (l) {
          if (m[1] === 'Ref' ? num(l[c.colId]) === pid : liste(l[c.colId]).map(num).indexOf(pid) >= 0) res.push({ table: t, col: c.colId, ligne: l, mode: m[1] });
        });
      });
    });
    if (type === 'Personnes') {
      data.Personnes.forEach(function (l) { if (num(l.Fusionne_dans) === pid) res.push({ table: 'Personnes', col: 'Fusionne_dans', ligne: l, mode: 'Ref' }); });
    } else {
      data.Personnes.forEach(function (l) { if (num(l.Structure) === pid) res.push({ table: 'Personnes', col: 'Structure', ligne: l, mode: 'Ref' }); });
      data.Structures.forEach(function (l) { if (num(l.Parent) === pid && l.id !== pid) res.push({ table: 'Structures', col: 'Parent', ligne: l, mode: 'Ref' }); });
    }
    return res;
  }
  function mentionsTexte(nom) {
    var res = [], cle = sansAccents(nom).trim();
    if (!cle) return res;
    Object.keys(MENTIONS_TEXTE).forEach(function (t) {
      MENTIONS_TEXTE[t].forEach(function (c) {
        var cc = col(t, c);
        if (!cc || cc.type !== 'Text') return;
        (autres[t] || []).forEach(function (l) {
          var morceaux = String(l[c] || '').split(/[,;\n]+/).map(function (x) { return sansAccents(x).trim(); });
          if (morceaux.indexOf(cle) >= 0) res.push({ table: t, col: c, ligne: l });
        });
      });
    });
    return res;
  }
  function remplacerNom(texte, ancien, nouveau) {
    var cle = sansAccents(ancien).trim();
    return String(texte || '').replace(/[^,;\n]+/g, function (m) { return sansAccents(m).trim() === cle ? m.replace(m.trim(), nouveau) : m; });
  }

  // Doublons probables : même courriel, ou même nom (sans accents, ordre des mots indifférent).
  function doublons() {
    var paires = {}, res = [];
    function ajouter(a, b, raison) {
      var k = Math.min(a.id, b.id) + '-' + Math.max(a.id, b.id);
      if (R.ignores.indexOf(k) >= 0) return;
      if (paires[k]) { if (paires[k].raisons.indexOf(raison) < 0) paires[k].raisons.push(raison); return; }
      paires[k] = { cle: k, a: a.id < b.id ? a : b, b: a.id < b.id ? b : a, raisons: [raison] }; res.push(paires[k]);
    }
    var vivantes = data.Personnes.filter(function (p) { return !num(p.Fusionne_dans); });
    [['courriel', emailDe, 'même courriel'], ['nom', function (p) { return cleNom(p.Nom); }, 'même nom']].forEach(function (g) {
      var groupes = {};
      vivantes.forEach(function (p) { var k = g[1](p); if (k) (groupes[k] = groupes[k] || []).push(p); });
      Object.keys(groupes).forEach(function (k) { var l = groupes[k]; for (var i = 0; i < l.length; i++) for (var j = i + 1; j < l.length; j++) ajouter(l[i], l[j], g[2]); });
    });
    return res;
  }
  function aPurger() {
    if (!R.purgeMois) return [];
    var limite = aujourdhui() - R.purgeMois * 30.44 * 86400;
    return data.Personnes.filter(function (p) { return archivee(p) && p.Archive_le && p.Archive_le < limite; });
  }

  // ---------------------------------------------------------------------------
  // Écritures
  // ---------------------------------------------------------------------------

  function ecrire(actions) {
    if (!DEMO) return grist.docApi.applyUserActions(actions);
    var ret = [];
    actions.forEach(function (a) {
      var t = a[1], tab = t === 'Personnes' || t === 'Structures' ? data[t] : (autres[t] = autres[t] || []);
      var parId = function (id) { return tab.filter(function (l) { return l.id === id; })[0]; };
      var maxId = function () { return tab.reduce(function (m, l) { return Math.max(m, l.id); }, 0); };
      if (a[0] === 'AddRecord') { var id = maxId() + 1; tab.push(Object.assign({ id: id }, a[3])); ret.push(id); }
      else if (a[0] === 'BulkAddRecord') {
        var ids = [], cles = Object.keys(a[3]);
        a[2].forEach(function (x, i) { var l = { id: maxId() + 1 }; cles.forEach(function (k) { l[k] = a[3][k][i]; }); tab.push(l); ids.push(l.id); });
        ret.push(ids);
      } else if (a[0] === 'UpdateRecord') { Object.assign(parId(a[2]) || {}, a[3]); ret.push(null); }
      else if (a[0] === 'BulkUpdateRecord') { a[2].forEach(function (id, i) { var l = parId(id); if (l) Object.keys(a[3]).forEach(function (k) { l[k] = a[3][k][i]; }); }); ret.push(null); }
      else if (a[0] === 'RemoveRecord' || a[0] === 'BulkRemoveRecord') {
        var suppr = a[0] === 'RemoveRecord' ? [a[2]] : a[2];
        var garde = tab.filter(function (l) { return suppr.indexOf(l.id) < 0; });
        tab.length = 0; garde.forEach(function (l) { tab.push(l); }); ret.push(null);
      } else ret.push(null);
    });
    indexer();
    return Promise.resolve({ retValues: ret });
  }
  function messageRefus(err, defaut) {
    var m = String((err && err.message) || err || '');
    if (/acl|access|permission|blocked|denied|refus/i.test(m)) return defaut + ' Grist a refusé l\'action : vos droits sur le document ne le permettent pas.';
    return defaut + ' (' + m + ')';
  }
  function executer(actions, message, apres, defautErreur) {
    return ecrire(actions).then(function (res) {
      if (apres) apres(res);
      etat.alerte = message ? { type: 'success', texte: message } : null;
      return DEMO ? null : charger();
    }).then(rendre).catch(function (err) {
      etat.alerte = { type: 'error', texte: messageRefus(err, defautErreur || 'Enregistrement impossible.') };
      rendre();
    });
  }

  // ---------------------------------------------------------------------------
  // Routage et éléments communs
  // ---------------------------------------------------------------------------

  function route() {
    var h = location.hash.replace(/^#\/?/, '').split('/');
    if (h[0] === 'personne' && num(h[1])) return { vue: h[2] === 'modifier' ? 'formPersonne' : 'personne', id: num(h[1]) };
    if (h[0] === 'nouvelle-personne') return { vue: 'formPersonne', id: 0, structure: num(h[1]) };
    if (h[0] === 'structures') return { vue: 'structures' };
    if (h[0] === 'structure' && num(h[1])) return { vue: h[2] === 'modifier' ? 'formStructure' : 'structure', id: num(h[1]) };
    if (h[0] === 'nouvelle-structure') return { vue: 'formStructure', id: 0, parent: num(h[1]) };
    if (h[0] === 'doublons') return { vue: 'doublons' };
    if (h[0] === 'fusion' && num(h[1]) && num(h[2])) return { vue: 'fusion', garde: num(h[1]), absorbe: num(h[2]) };
    if (h[0] === 'importer') return { vue: 'importer' };
    if (h[0] === 'moi') return { vue: 'moi' };
    if (h[0] === 'reglages') return { vue: 'reglages' };
    return { vue: 'personnes' };
  }

  function navigation(active) {
    var nd = doublons().length;
    var liens = [['#/', 'Personnes', 'personnes'], ['#/structures', 'Structures', 'structures'],
      ['#/doublons', 'Doublons' + (nd ? ' (' + nd + ')' : ''), 'doublons'], ['#/importer', 'Importer', 'importer'], ['#/moi', 'Ma fiche', 'moi']];
    return '<nav class="an-nav" aria-label="Navigation de l\'annuaire"><ul class="fr-btns-group fr-btns-group--inline-sm fr-btns-group--sm">' +
      liens.map(function (l) {
        return '<li><a class="fr-btn ' + (l[2] === active ? '' : 'fr-btn--secondary') + '" href="' + l[0] + '"' + (l[2] === active ? ' aria-current="page"' : '') + '>' + l[1] + '</a></li>';
      }).join('') + '<li><a class="fr-btn fr-btn--tertiary" href="#/reglages">Configurer</a></li></ul></nav>';
  }
  function blocAlerte() {
    if (!etat.alerte) return '';
    return '<div class="fr-alert fr-alert--sm fr-alert--' + etat.alerte.type + ' an-alerte" role="' + (etat.alerte.type === 'error' ? 'alert' : 'status') + '"><p>' + esc(etat.alerte.texte) + '</p></div>';
  }
  function blocMiseAJour() {
    if (DEMO) return '';
    var m = colonnesManquantes();
    if (!m.length) return '';
    return '<div class="fr-notice fr-notice--info fr-mb-2w"><div class="fr-notice__body"><p class="fr-notice__title">Le document peut être complété pour l\'annuaire : ' + esc(m.join(', ')) + '. ' +
      'Rien n\'est renommé ni supprimé. À faire une fois, par un propriétaire du document.</p>' +
      '<p class="fr-text--sm">Si l\'une de vos colonnes contient déjà cette information sous un autre nom (par exemple <code>Mail</code> au lieu de <code>Email</code>), renommez-la d\'abord dans Grist avec le nom attendu : ses données seront reprises.</p></div></div>' +
      '<button type="button" class="fr-btn fr-btn--sm fr-mb-3w" data-action="mettre-a-jour">Mettre le document à jour</button>';
  }
  function blocMention() { return R.mention ? '<p class="an-mention">' + esc(R.mention) + '</p>' : ''; }

  function champ(id, lib, val, o) {
    o = o || {};
    var attrs = (o.attrs || '') + (o.requis ? ' required' : '');
    var aide = o.aide ? '<span class="fr-hint-text">' + esc(o.aide) + '</span>' : '';
    var saisie = o.multiligne ?
      '<textarea class="fr-input" id="' + id + '" rows="' + (o.lignes || 3) + '" ' + attrs + '>' + esc(val) + '</textarea>' :
      '<input class="fr-input" id="' + id + '" type="' + (o.type || 'text') + '" value="' + esc(val) + '" ' + attrs + '>';
    return '<div class="fr-input-group' + (o.classe ? ' ' + o.classe : '') + '"><label class="fr-label" for="' + id + '">' + esc(lib) + (o.requis ? ' <span class="an-requis">(obligatoire)</span>' : '') + aide + '</label>' + saisie + '</div>';
  }
  function select(id, lib, val, options, attrs, vide, classe) {
    var h = '<div class="fr-select-group' + (classe ? ' ' + classe : '') + '"><label class="fr-label" for="' + id + '">' + esc(lib) + '</label><select class="fr-select" id="' + id + '" ' + (attrs || '') + '>';
    if (vide !== undefined) h += '<option value="">' + esc(vide) + '</option>';
    options.forEach(function (o) { var v = Array.isArray(o) ? o[0] : o, t = Array.isArray(o) ? o[1] : o; h += '<option value="' + esc(v) + '"' + (String(v) === String(val) ? ' selected' : '') + '>' + esc(t) + '</option>'; });
    return h + '</select></div>';
  }
  function optionsStructures() {
    return structuresTriees().map(function (x) { return [x.s.id, new Array(x.niveau + 1).join('   ') + (x.s.Sigle ? x.s.Sigle + ' – ' : '') + (x.s.Nom || 'Sans nom')]; });
  }
  function lienCourriel(e) { return courrielValide(e) ? '<a href="mailto:' + esc(e) + '">' + esc(e) + '</a>' : esc(e); }
  function lienTel(t) { var n = String(t || '').replace(/[^\d+]/g, ''); return n ? '<a href="tel:' + esc(n) + '">' + esc(t) + '</a>' : esc(t); }
  function valeurTexte(c, v) {
    if (c.type === 'choixMultiple') return liste(v).join(', ');
    if (c.type === 'date') return dateTexte(v);
    if (c.type === 'case') return v ? 'Oui' : 'Non';
    return v === null || v === undefined ? '' : String(v);
  }

  // ---------------------------------------------------------------------------
  // Vue : personnes
  // ---------------------------------------------------------------------------

  function filtrer() {
    var f = etat.f, q = sansAccents(f.q).trim(), mots = q ? q.split(/\s+/) : [];
    var ens = f.structure ? descendants(f.structure) : null;
    var purge = f.statut === 'purge' ? aPurger().map(function (p) { return p.id; }) : null;
    var perso = R.perso.filter(function (c) { return (c.type === 'choix' || c.type === 'choixMultiple') && f.perso[c.col]; });
    return data.Personnes.filter(function (p) {
      if (f.statut === 'actives' && archivee(p)) return false;
      if (f.statut === 'archivees' && !archivee(p)) return false;
      if (purge && purge.indexOf(p.id) < 0) return false;
      if (ens && !ens[num(p.Structure)]) return false;
      if (f.fonction && String(p.Fonction || '').trim() !== f.fonction) return false;
      if (f.sansCourriel && emailDe(p)) return false;
      if (f.gestion && !p.Gestion_annuaire) return false;
      if (f.admin && p.Role !== 'Administration') return false;
      if (f.aVerifier && !p.A_verifier) return false;
      if (perso.some(function (c) { return liste(p[c.col]).indexOf(f.perso[c.col]) < 0; })) return false;
      if (mots.length) {
        var texte = sansAccents([p.Nom, emailDe(p), p.Fonction, cheminStructure(p.Structure), nomsChaine(p.Structure)].concat(champsActifs().map(function (c) { return valeurTexte(c, p[c.col]); })).join(' '));
        if (!mots.every(function (m) { return texte.indexOf(m) >= 0; })) return false;
      }
      return true;
    }).sort(function (a, b) {
      if (etat.tri === 'structure') return cheminStructure(a.Structure).localeCompare(cheminStructure(b.Structure), 'fr') || triNom(a, b);
      return triNom(a, b);
    });
  }

  function vuePersonnes() {
    var f = etat.f;
    var fonctions = {}; data.Personnes.forEach(function (p) { var x = String(p.Fonction || '').trim(); if (x) fonctions[x] = 1; });
    var h = navigation('personnes') + '<div class="an-titre-ligne"><h1 class="fr-h3">Personnes <span class="an-compte">(' + data.Personnes.filter(function (p) { return !archivee(p); }).length + ' actives)</span></h1>' +
      '<a class="fr-btn fr-icon-add-line fr-btn--icon-left" href="#/nouvelle-personne">Ajouter une personne</a></div>' + blocAlerte() + blocMiseAJour();
    h += '<div class="fr-search-bar an-recherche" role="search"><label class="fr-label" for="f-q">Rechercher une personne</label>' +
      '<input class="fr-input" type="search" id="f-q" data-filtre="q" value="' + esc(f.q) + '" placeholder="Nom, courriel, fonction, structure…" autocomplete="off"></div>';
    h += '<div class="an-filtres">' +
      select('f-structure', 'Structure (et ses services)', f.structure, optionsStructures(), 'data-filtre="structure"', 'Toutes') +
      select('f-fonction', 'Fonction', f.fonction, Object.keys(fonctions).sort(function (a, b) { return a.localeCompare(b, 'fr'); }), 'data-filtre="fonction"', 'Toutes') +
      select('f-statut', 'Statut', f.statut, [['actives', 'Actives'], ['archivees', 'Archivées'], ['purge', 'Archivées depuis plus de ' + R.purgeMois + ' mois'], ['toutes', 'Toutes']].filter(function (o) { return o[0] !== 'purge' || R.purgeMois; }), 'data-filtre="statut"') +
      R.perso.filter(function (c) { return !c.masque && (c.type === 'choix' || c.type === 'choixMultiple') && aCol('Personnes', c.col); }).map(function (c) {
        return select('f-p-' + c.col, c.libelle, f.perso[c.col] || '', c.options || [], 'data-filtre-perso="' + esc(c.col) + '"', 'Toutes');
      }).join('') +
      '<div class="fr-checkbox-group fr-checkbox-group--sm"><input type="checkbox" id="f-sans" data-filtre="sansCourriel"' + (f.sansCourriel ? ' checked' : '') + '><label class="fr-label" for="f-sans">Sans courriel</label></div>' +
      '<div class="fr-checkbox-group fr-checkbox-group--sm"><input type="checkbox" id="f-gest" data-filtre="gestion"' + (f.gestion ? ' checked' : '') + '><label class="fr-label" for="f-gest">Gestionnaires de l\'annuaire</label></div>' +
      (aCol('Personnes', 'Role') ? '<div class="fr-checkbox-group fr-checkbox-group--sm"><input type="checkbox" id="f-admin" data-filtre="admin"' + (f.admin ? ' checked' : '') + '><label class="fr-label" for="f-admin">Rôle Administration (projets)</label></div>' : '') +
      (aCol('Personnes', 'A_verifier') ? '<div class="fr-checkbox-group fr-checkbox-group--sm"><input type="checkbox" id="f-verif" data-filtre="aVerifier"' + (f.aVerifier ? ' checked' : '') + '><label class="fr-label" for="f-verif">Profil à vérifier</label></div>' : '') +
      select('f-tri', 'Trier par', etat.tri, [['nom', 'Nom'], ['structure', 'Structure']], 'data-tri') +
      '</div><div id="an-resultats">' + resultatsPersonnes() + '</div>' + blocMention();
    return h;
  }

  function resultatsPersonnes() {
    var res = filtrer(), total = res.length, pages = Math.max(1, Math.ceil(total / PAR_PAGE));
    if (etat.page >= pages) etat.page = pages - 1;
    var vue = res.slice(etat.page * PAR_PAGE, (etat.page + 1) * PAR_PAGE);
    var champs = champsActifs().filter(function (c) { return /^Telephone_/.test(c.col); });
    var h = '<p class="an-resultat" role="status" aria-live="polite">' + total + ' personne' + (total > 1 ? 's' : '') + (total !== data.Personnes.length ? ' sur ' + data.Personnes.length : '') + '</p>';
    if (etat.f.statut === 'purge' && total) {
      h += '<div class="fr-alert fr-alert--warning fr-alert--sm fr-mb-2w"><p>Ces fiches sont archivées depuis plus de ' + R.purgeMois + ' mois, le délai de conservation réglé. ' +
        '<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary fr-ml-1w" data-action="purger">Supprimer ces ' + total + ' fiches</button></p></div>';
    }
    if (!total) return h + '<p>Aucune personne ne correspond. <button type="button" class="fr-btn fr-btn--tertiary-no-outline fr-btn--sm" data-action="effacer-filtres">Effacer la recherche et les filtres</button></p>';
    h += '<div class="fr-table fr-table--no-caption an-table"><div class="fr-table__wrapper"><div class="fr-table__container"><div class="fr-table__content"><table>' +
      '<caption>Personnes de l\'annuaire</caption><thead><tr><th scope="col">Nom</th><th scope="col">Structure</th>' + (R.champs.fonction ? '<th scope="col">Fonction</th>' : '') +
      '<th scope="col">Courriel</th>' + champs.map(function (c) { return '<th scope="col">' + esc(c.libelle.replace(' professionnel', '')) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      vue.map(function (p) {
        var b = [];
        if (archivee(p)) b.push(badge('Archivée'));
        if (p.Gestion_annuaire) b.push(badge('Gestionnaire', 'info'));
        if (p.Role === 'Administration') b.push(badge('Administration', 'new'));
        return '<tr><td><a href="#/personne/' + p.id + '">' + esc(p.Nom || 'Sans nom') + '</a>' + (b.length ? '<ul class="an-badges"><li>' + b.join('</li><li>') + '</li></ul>' : '') + '</td>' +
          '<td>' + esc(cheminStructure(p.Structure)) + '</td>' + (R.champs.fonction ? '<td>' + esc(p.Fonction) + '</td>' : '') +
          '<td>' + (emailDe(p) ? lienCourriel(emailDe(p)) : '<span class="an-compte">Aucun</span>') + '</td>' +
          champs.map(function (c) { return '<td>' + lienTel(p[c.col]) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></div></div></div>';
    if (pages > 1) {
      h += '<nav class="an-pagination" aria-label="Pages de résultats">' +
        '<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-page="' + (etat.page - 1) + '"' + (etat.page ? '' : ' disabled') + '>Page précédente</button>' +
        '<span>Page ' + (etat.page + 1) + ' sur ' + pages + '</span>' +
        '<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-page="' + (etat.page + 1) + '"' + (etat.page < pages - 1 ? '' : ' disabled') + '>Page suivante</button></nav>';
    }
    return h;
  }

  // ---------------------------------------------------------------------------
  // Vue : fiche d'une personne
  // ---------------------------------------------------------------------------

  function blocApparitions(pid) {
    var p = idx.Personnes[pid], refs = apparitions(pid), txt = mentionsTexte(p.Nom);
    if (!refs.length && !txt.length) return '<p class="fr-text--sm">Cette personne n\'est citée nulle part ailleurs dans le document.</p>';
    var parTable = {};
    refs.concat(txt.map(function (m) { return Object.assign({ texte: true }, m); })).forEach(function (r) { (parTable[r.table] = parTable[r.table] || []).push(r); });
    var cible = num(p.Fusionne_dans) && idx.Personnes[num(p.Fusionne_dans)];
    return '<ul class="an-liste-simple">' + Object.keys(parTable).map(function (t) {
      return '<li><strong>' + esc(NOMS_TABLES[t] || t) + '</strong> (' + parTable[t].length + ')<ul>' + parTable[t].slice(0, 12).map(function (r) {
        var lib = t === 'Personnes' ? '<a href="#/personne/' + r.ligne.id + '">' + esc(r.ligne.Nom) + '</a> (fusionnée dans cette fiche)' : esc(libelleLigne(t, r.ligne));
        return '<li>' + lib + ' <span class="an-raison">· ' + esc(r.col) + (r.texte ? ', nom écrit en texte' : '') + '</span>' +
          (r.texte && cible ? ' <button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary-no-outline" data-remplacer="' + esc(t) + ':' + r.ligne.id + ':' + esc(r.col) + '">Remplacer par « ' + esc(cible.Nom) + ' »</button>' : '') + '</li>';
      }).join('') + (parTable[t].length > 12 ? '<li>…</li>' : '') + '</ul></li>';
    }).join('') + '</ul>';
  }

  function vuePersonne(id) {
    var p = idx.Personnes[id];
    if (!p) return navigation('') + '<p>Cette personne n\'existe plus. <a href="#/">Retour à la liste</a></p>';
    var cible = num(p.Fusionne_dans) && idx.Personnes[num(p.Fusionne_dans)];
    var infos = [['Courriel', emailDe(p) ? lienCourriel(emailDe(p)) : 'Aucun'], ['Structure', esc(cheminStructure(p.Structure)) || 'Aucune']];
    champsActifs().forEach(function (c) {
      var v = p[c.col];
      infos.push([c.libelle, /^Telephone_/.test(c.col) ? lienTel(v) : esc(valeurTexte(c, v)).replace(/\n/g, '<br>')]);
    });
    if (aCol('Personnes', 'Role')) infos.push(['Rôle dans les projets', esc(p.Role || 'Membre')]);
    var b = [];
    if (archivee(p)) b.push(badge('Archivée le ' + dateTexte(p.Archive_le)));
    if (p.Gestion_annuaire) b.push(badge('Gestionnaire de l\'annuaire', 'info'));
    var h = navigation('') + '<div class="an-titre-ligne"><div><h1 class="fr-h3">' + esc(p.Nom || 'Sans nom') + '</h1>' + (b.length ? '<ul class="an-badges">' + b.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' : '') + '</div>' +
      '<a class="fr-link fr-icon-arrow-left-line fr-link--icon-left" href="#/">Retour à la liste</a></div>' + blocAlerte();
    if (cible) h += '<div class="fr-notice fr-notice--info fr-mb-2w"><div class="fr-notice__body"><p class="fr-notice__title">Fiche fusionnée dans <a href="#/personne/' + cible.id + '">' + esc(cible.Nom) + '</a>.</p></div></div>';
    h += '<div class="an-fiche"><div><dl class="an-infos">' + infos.map(function (i) { return '<dt>' + esc(i[0]) + '</dt><dd>' + (i[1] || '–') + '</dd>'; }).join('') + '</dl>' +
      '<ul class="fr-btns-group fr-btns-group--inline-sm fr-btns-group--sm fr-mt-3w">' +
      '<li><a class="fr-btn" href="#/personne/' + p.id + '/modifier">Modifier</a></li>' +
      '<li><button type="button" class="fr-btn fr-btn--secondary" data-archiver="' + p.id + '">' + (archivee(p) ? 'Réactiver' : 'Archiver') + '</button></li>' +
      '<li><button type="button" class="fr-btn fr-btn--secondary" data-fusionner-avec="' + p.id + '" aria-expanded="' + (etat.fusionAvec === p.id) + '">Fusionner avec…</button></li>' +
      '<li><button type="button" class="fr-btn fr-btn--tertiary" data-exporter="' + p.id + '">Exporter ses données</button></li>' +
      '<li><button type="button" class="fr-btn fr-btn--tertiary" data-supprimer="Personnes:' + p.id + '">Supprimer</button></li></ul>' +
      blocConfirmation('Personnes', p.id) + blocFusionAvec(p.id) +
      '</div><aside class="an-lateral"><h2 class="fr-h6">Apparaît dans</h2>' + blocApparitions(p.id) + '</aside></div>' + blocMention();
    return h;
  }

  function blocFusionAvec(pid) {
    if (etat.fusionAvec !== pid) return '';
    var autresP = data.Personnes.filter(function (x) { return x.id !== pid && !num(x.Fusionne_dans); }).sort(triNom);
    return '<form class="an-paire fr-mt-2w" data-form="fusion-avec" data-id="' + pid + '">' +
      select('fa-autre', 'Fiche en double à fusionner dans celle-ci', '', autresP.map(function (x) { return [x.id, x.Nom + (emailDe(x) ? ' (' + emailDe(x) + ')' : '')]; }), 'required', 'Choisir une personne') +
      '<button class="fr-btn fr-btn--sm" type="submit">Voir ce que la fusion va changer</button></form>';
  }

  function blocConfirmation(type, id) {
    var c = etat.confirmation;
    if (!c || c.type !== type || c.ids.indexOf(id) < 0 || c.ids.length !== 1) return '';
    return texteConfirmation(c);
  }
  function texteConfirmation(c) {
    var refs = [], txt = [];
    c.ids.forEach(function (id) {
      refs = refs.concat(apparitions(id, c.type));
      if (c.type === 'Personnes') txt = txt.concat(mentionsTexte(idx.Personnes[id].Nom));
    });
    var tables = {}; refs.forEach(function (r) { tables[NOMS_TABLES[r.table] || r.table] = 1; });
    return '<div class="fr-alert fr-alert--warning fr-mt-2w" role="alert"><h2 class="fr-alert__title">Supprimer définitivement ' + (c.ids.length > 1 ? 'ces ' + c.ids.length + ' fiches' : 'cette fiche') + ' ?</h2>' +
      '<p>' + (refs.length ? 'Elle' + (c.ids.length > 1 ? 's sont' : ' est') + ' citée' + (c.ids.length > 1 ? 's' : '') + ' ' + refs.length + ' fois (' + esc(Object.keys(tables).join(', ')) + ') : ces mentions seront vidées. ' : '') +
      (txt.length ? txt.length + ' mention' + (txt.length > 1 ? 's' : '') + ' du nom en texte resteront telles quelles. ' : '') +
      'La suppression ne peut pas être annulée, sauf depuis l\'historique du document Grist.</p>' +
      '<ul class="fr-btns-group fr-btns-group--inline-sm fr-btns-group--sm fr-mt-1w"><li><button type="button" class="fr-btn" data-action="confirmer-suppression">Supprimer</button></li>' +
      '<li><button type="button" class="fr-btn fr-btn--secondary" data-action="annuler-suppression">Annuler</button></li></ul></div>';
  }

  // ---------------------------------------------------------------------------
  // Vue : formulaire d'une personne
  // ---------------------------------------------------------------------------

  function saisiePerso(c, id, val, attrs) {
    if (c.type === 'texteLong') return champ(id, c.libelle, val || '', { multiligne: true, attrs: attrs, classe: 'an-large' });
    if (c.type === 'nombre') return champ(id, c.libelle, val === null || val === undefined ? '' : val, { type: 'number', attrs: attrs + ' step="any"' });
    if (c.type === 'date') return champ(id, c.libelle, typeof val === 'number' ? dateVersSaisie(val) : (val || ''), { type: 'date', attrs: attrs });
    if (c.type === 'choix') return select(id, c.libelle, val || '', c.options || [], attrs, 'Non renseigné');
    if (c.type === 'case') return '<div class="fr-checkbox-group fr-mb-2w"><input type="checkbox" id="' + id + '" ' + attrs + (val ? ' checked' : '') + '><label class="fr-label" for="' + id + '">' + esc(c.libelle) + '</label></div>';
    if (c.type === 'choixMultiple') {
      var v = liste(val);
      return '<fieldset class="fr-fieldset an-large"><legend class="fr-fieldset__legend fr-text--regular">' + esc(c.libelle) + '</legend>' + (c.options || []).map(function (o, i) {
        return '<div class="fr-fieldset__element fr-fieldset__element--inline"><div class="fr-checkbox-group fr-checkbox-group--sm"><input type="checkbox" id="' + id + '-' + i + '" ' + attrs + ' data-option="' + esc(o) + '"' + (v.indexOf(o) >= 0 ? ' checked' : '') + '><label class="fr-label" for="' + id + '-' + i + '">' + esc(o) + '</label></div></div>';
      }).join('') + '</fieldset>';
    }
    var tel = /^Telephone_/.test(c.col);
    return champ(id, c.libelle, val || '', { type: tel ? 'tel' : 'text', attrs: attrs + (tel ? ' autocomplete="off"' : '') + (c.col === 'Fonction' ? ' list="an-fonctions"' : '') });
  }

  function vueFormPersonne(id, structure) {
    var p = id ? idx.Personnes[id] : null;
    if (id && !p) return navigation('') + '<p>Cette personne n\'existe plus.</p>';
    var cle = 'p-' + (id || 'nouvelle'), b = brouillon(cle);
    if (!b._init) {
      b._init = true; b.Nom = p ? p.Nom || '' : ''; b.Email = p ? emailDe(p) : (etat.depuisMoi ? moi.email : ''); etat.depuisMoi = false; b.Structure = p ? num(p.Structure) || '' : (structure || '');
      b.Gestion_annuaire = p ? !!p.Gestion_annuaire : false;
      champsActifs().forEach(function (c) { b[c.col] = p ? p[c.col] : (c.type === 'choixMultiple' ? ['L'] : null); });
    }
    var a = function (c) { return 'data-brouillon="' + cle + '" data-champ="' + c + '"'; };
    var fonctions = {}; data.Personnes.forEach(function (x) { if (x.Fonction) fonctions[String(x.Fonction).trim()] = 1; });
    var h = navigation(id ? '' : 'personnes') + '<div class="an-titre-ligne"><h1 class="fr-h3">' + (p ? 'Modifier la fiche de ' + esc(p.Nom) : 'Ajouter une personne') + '</h1>' +
      '<a class="fr-link fr-icon-arrow-left-line fr-link--icon-left" href="' + (p ? '#/personne/' + p.id : '#/') + '">Retour</a></div>' + blocAlerte() +
      '<form class="an-form" data-form="personne" data-id="' + (id || 0) + '" data-cle="' + cle + '"><div class="an-grille">' +
      champ('pf-nom', 'Nom', b.Nom, { requis: true, attrs: a('Nom') + ' autocomplete="off"', aide: 'Tel qu\'il doit apparaître dans les autres outils, par exemple « Camille Martin ».' }) +
      champ('pf-email', 'Courriel professionnel', b.Email, { type: 'email', attrs: a('Email') + ' autocomplete="off"', aide: 'Il permet de reconnaître la personne quand elle se connecte à Grist.' }) +
      '<div id="pf-doublon" class="an-large" aria-live="polite">' + avisDoublon(id, b.Email) + '</div>' +
      (colCourriel() || DEMO ? '' : '<p class="fr-text--xs an-large">Le courriel ne peut pas être enregistré : la colonne Email de ce document est une formule sans colonne de saisie.</p>') +
      select('pf-structure', 'Structure ou équipe de rattachement', b.Structure, optionsStructures(), a('Structure'), 'Aucune') +
      champsActifs().map(function (c) { return saisiePerso(c, 'pf-' + c.col, b[c.col], a(c.col)); }).join('') +
      '<datalist id="an-fonctions">' + Object.keys(fonctions).sort().map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist>' +
      '<div class="fr-checkbox-group an-large fr-mb-2w"><input type="checkbox" id="pf-gestion" ' + a('Gestion_annuaire') + (b.Gestion_annuaire ? ' checked' : '') + '>' +
      '<label class="fr-label" for="pf-gestion">Gestionnaire de l\'annuaire<span class="fr-hint-text">Peut corriger, archiver, fusionner et importer des fiches sans être propriétaire du document. Seuls les propriétaires attribuent ce rôle.</span></label></div>' +
      '</div><ul class="fr-btns-group fr-btns-group--inline-md"><li><button class="fr-btn" type="submit">Enregistrer</button></li>' +
      '<li><a class="fr-btn fr-btn--secondary" href="' + (p ? '#/personne/' + p.id : '#/') + '" data-annuler="' + cle + '">Annuler</a></li></ul></form>';
    return h;
  }

  function avisDoublon(id, email) {
    var d = email && data.Personnes.filter(function (x) { return x.id !== id && emailDe(x) === String(email).trim().toLowerCase(); })[0];
    return d ? '<div class="fr-alert fr-alert--warning fr-alert--sm fr-mb-2w"><p>Ce courriel est déjà celui de <a href="#/personne/' + d.id + '">' + esc(d.Nom) + '</a>.</p></div>' : '';
  }
  function champsPersonneDepuisBrouillon(b, p) {
    var o = { Nom: String(b.Nom || '').trim(), Structure: num(b.Structure) };
    if (!aCol('Personnes', 'Structure')) delete o.Structure;
    var cc = DEMO ? 'Email' : colCourriel();
    if (cc && (!p || String(b.Email || '').trim().toLowerCase() !== emailDe(p))) o[cc] = String(b.Email || '').trim().toLowerCase();
    champsActifs().forEach(function (c) {
      var v = b[c.col];
      if (c.type === 'nombre') v = v === '' || v === null || v === undefined ? null : Number(v);
      else if (c.type === 'date') v = typeof v === 'number' ? v : saisieVersDate(v);
      else if (c.type === 'case') v = !!v;
      else if (c.type === 'choixMultiple') v = ['L'].concat(liste(v));
      else if (v === undefined || v === null) v = '';
      o[c.col] = v;
    });
    if (aCol('Personnes', 'Gestion_annuaire') && (!p || !!b.Gestion_annuaire !== !!p.Gestion_annuaire)) o.Gestion_annuaire = !!b.Gestion_annuaire;
    return o;
  }

  // ---------------------------------------------------------------------------
  // Vue : ma fiche
  // ---------------------------------------------------------------------------

  function vueMoi() {
    var h = navigation('moi') + '<h1 class="fr-h3">Ma fiche</h1>' + blocAlerte();
    if (!moi.email) {
      if (!data.Comptes && !DEMO) return h + '<p>Pour vous reconnaître, l\'annuaire a besoin de la table <code>Comptes</code>, créée à l\'installation. Demandez à un propriétaire du document de cliquer sur « Mettre le document à jour ».</p>';
      if (!moi.verifie) return h + '<p>Identification en cours…</p>';
      return h + '<p>L\'annuaire ne peut pas vous reconnaître : il faut pouvoir modifier le document (droit d\'édition). Demandez à un gestionnaire de corriger votre fiche.</p>' + blocMention();
    }
    var p = personneDe(moi.email);
    if (p) { setTimeout(function () { location.replace('#/personne/' + p.id); }, 0); return h + '<p>Ouverture de votre fiche…</p>'; }
    return h + '<p>Vous êtes connecté avec l\'adresse <strong>' + esc(moi.email) + '</strong>, qui n\'est celle d\'aucune fiche. ' +
      'Créez votre fiche, ou demandez à un gestionnaire d\'ajouter cette adresse à votre fiche existante.</p>' +
      '<a class="fr-btn" href="#/nouvelle-personne" data-moi="1">Créer ma fiche</a>' + blocMention();
  }
  function assurerCompte() {
    if (DEMO || moi.email || !data.Comptes) { moi.verifie = true; return Promise.resolve(); }
    // Une ligne ajoutée à Comptes reçoit l'adresse de la personne connectée (formule d'initialisation).
    var nid = null;
    return grist.docApi.applyUserActions([['AddRecord', 'Comptes', null, {}]]).then(function (r) {
      nid = r.retValues[0];
      return grist.docApi.fetchTable('Comptes');
    }).then(function (c) {
      var lignes = lignesDepuisColonnes(c), mienne = lignes.filter(function (l) { return l.id === nid; })[0];
      moi.email = mienne && mienne.Email ? String(mienne.Email).toLowerCase() : '';
      // Une seule ligne par personne : la nouvelle est retirée si une autre porte déjà cette adresse.
      var autre = lignes.filter(function (l) { return l.id !== nid && String(l.Email || '').toLowerCase() === moi.email; })[0];
      moi.verifie = true;
      if (autre || !moi.email) return grist.docApi.applyUserActions([['RemoveRecord', 'Comptes', nid]]).catch(function () {});
    }).catch(function () { moi.verifie = true; });
  }

  // ---------------------------------------------------------------------------
  // Vues : structures
  // ---------------------------------------------------------------------------

  function vueStructures() {
    var h = navigation('structures') + '<div class="an-titre-ligne"><h1 class="fr-h3">Structures <span class="an-compte">(' + data.Structures.length + ')</span></h1>' +
      '<a class="fr-btn fr-icon-add-line fr-btn--icon-left" href="#/nouvelle-structure">Ajouter une structure</a></div>' + blocAlerte() + blocMiseAJour();
    h += '<div class="fr-search-bar an-recherche" role="search"><label class="fr-label" for="f-qs">Rechercher une structure</label>' +
      '<input class="fr-input" type="search" id="f-qs" data-filtre-structures value="' + esc(etat.qs || '') + '" placeholder="Nom, sigle, type…" autocomplete="off"></div>' +
      '<div id="an-resultats">' + resultatsStructures() + '</div>';
    return h;
  }
  function resultatsStructures() {
    if (!data.Structures.length) return '<p>Aucune structure. <a href="#/nouvelle-structure">Ajouter la première</a>.</p>';
    var q = sansAccents(etat.qs || '').trim();
    if (q) {
      var res = data.Structures.filter(function (s) { return sansAccents([s.Nom, s.Sigle, s.Type, cheminStructure(s.id)].join(' ')).indexOf(q) >= 0; }).sort(triNom);
      return '<p class="an-resultat" role="status">' + res.length + ' structure' + (res.length > 1 ? 's' : '') + '</p><ul class="an-liste-simple">' + res.map(function (s) {
        return '<li><a href="#/structure/' + s.id + '">' + esc(cheminStructure(s.id)) + '</a> <span class="an-arbre__n">' + membres(s.id).length + ' personne(s)</span></li>';
      }).join('') + '</ul>';
    }
    var vus = {};
    function noeud(s) {
      if (vus[s.id]) return ''; vus[s.id] = 1;
      var e = enfants(s.id).sort(triNom), n = membres(s.id).length;
      return '<li><a href="#/structure/' + s.id + '">' + esc((s.Sigle ? s.Sigle + ' – ' : '') + (s.Nom || 'Sans nom')) + '</a> ' + (s.Type ? badge(s.Type) + ' ' : '') +
        '<span class="an-arbre__n">' + n + ' personne' + (n > 1 ? 's' : '') + '</span>' + (e.length ? '<ul>' + e.map(noeud).join('') + '</ul>' : '') + '</li>';
    }
    var racines = data.Structures.filter(function (s) { return !num(s.Parent) || !idx.Structures[num(s.Parent)]; }).sort(triNom);
    var h = '<ul class="an-arbre">' + racines.map(noeud).join('');
    data.Structures.forEach(function (s) { if (!vus[s.id]) h += noeud(s); });
    return h + '</ul>';
  }

  function vueStructure(id) {
    var s = idx.Structures[id];
    if (!s) return navigation('structures') + '<p>Cette structure n\'existe plus. <a href="#/structures">Retour</a></p>';
    var parent = idx.Structures[num(s.Parent)], e = enfants(id).sort(triNom), m = membres(id).sort(triNom), mt = membres(id, true).length;
    var infos = [['Chemin', esc(cheminStructure(id))], ['Type', esc(s.Type)], ['Adresse', esc(s.Adresse)], ['Courriel', s.Courriel ? lienCourriel(s.Courriel) : ''],
      ['Site', /^https:\/\//i.test(s.Site || '') ? '<a href="' + esc(s.Site) + '" target="_blank" rel="noopener">' + esc(s.Site) + '</a>' : esc(s.Site)]].filter(function (i) { return i[1]; });
    var refs = apparitions(id, 'Structures').filter(function (r) { return r.table !== 'Personnes' && r.table !== 'Structures'; });
    var h = navigation('structures') + '<div class="an-titre-ligne"><h1 class="fr-h3">' + esc((s.Sigle ? s.Sigle + ' – ' : '') + (s.Nom || 'Sans nom')) + '</h1>' +
      '<a class="fr-link fr-icon-arrow-left-line fr-link--icon-left" href="#/structures">Toutes les structures</a></div>' + blocAlerte() +
      '<div class="an-fiche"><div><dl class="an-infos">' + infos.map(function (i) { return '<dt>' + esc(i[0]) + '</dt><dd>' + i[1] + '</dd>'; }).join('') + '</dl>' +
      '<h2 class="fr-h5 fr-mt-3w">Personnes (' + m.length + (mt > m.length ? ', ' + mt + ' avec les services' : '') + ')</h2>' +
      (m.length ? '<ul class="an-liste-simple">' + m.map(function (p) { return '<li><a href="#/personne/' + p.id + '">' + esc(p.Nom) + '</a>' + (p.Fonction ? ' · ' + esc(p.Fonction) : '') + '</li>'; }).join('') + '</ul>' : '<p>Aucune personne rattachée directement.</p>') +
      '<ul class="fr-btns-group fr-btns-group--inline-sm fr-btns-group--sm fr-mt-3w">' +
      '<li><a class="fr-btn" href="#/structure/' + id + '/modifier">Modifier</a></li>' +
      '<li><a class="fr-btn fr-btn--secondary" href="#/nouvelle-personne/' + id + '">Ajouter une personne</a></li>' +
      (aCol('Structures', 'Parent') ? '<li><a class="fr-btn fr-btn--secondary" href="#/nouvelle-structure/' + id + '">Ajouter un service</a></li>' : '') +
      '<li><button type="button" class="fr-btn fr-btn--tertiary" data-supprimer="Structures:' + id + '">Supprimer</button></li></ul>' +
      (etat.confirmation && etat.confirmation.type === 'Structures' && etat.confirmation.ids[0] === id ? texteConfirmation(etat.confirmation) : '') +
      '</div><aside class="an-lateral">' +
      (parent ? '<h2 class="fr-h6">Rattachée à</h2><p><a href="#/structure/' + parent.id + '">' + esc(parent.Nom) + '</a></p>' : '') +
      '<h2 class="fr-h6">Services et équipes</h2>' + (e.length ? '<ul class="an-liste-simple">' + e.map(function (x) { return '<li><a href="#/structure/' + x.id + '">' + esc(x.Nom) + '</a></li>'; }).join('') + '</ul>' : '<p class="fr-text--sm">Aucun.</p>') +
      '<h2 class="fr-h6 fr-mt-2w">Citée ailleurs</h2>' + (refs.length ? '<ul class="an-liste-simple">' + refs.slice(0, 15).map(function (r) { return '<li>' + esc(NOMS_TABLES[r.table] || r.table) + ' : ' + esc(libelleLigne(r.table, r.ligne)) + '</li>'; }).join('') + '</ul>' : '<p class="fr-text--sm">Nulle part.</p>') +
      '</aside></div>';
    return h;
  }

  function vueFormStructure(id, parent) {
    var s = id ? idx.Structures[id] : null;
    if (id && !s) return navigation('structures') + '<p>Cette structure n\'existe plus.</p>';
    var cle = 's-' + (id || 'nouvelle'), b = brouillon(cle);
    if (!b._init) {
      b._init = true;
      ['Nom', 'Sigle', 'Type', 'Adresse', 'Courriel', 'Site'].forEach(function (k) { b[k] = s ? s[k] || '' : ''; });
      b.Parent = s ? num(s.Parent) || '' : (parent || '');
    }
    var a = function (c) { return 'data-brouillon="' + cle + '" data-champ="' + c + '"'; };
    var exclus = id ? descendants(id) : {};
    var h = navigation('structures') + '<div class="an-titre-ligne"><h1 class="fr-h3">' + (s ? 'Modifier ' + esc(s.Nom) : 'Ajouter une structure') + '</h1>' +
      '<a class="fr-link fr-icon-arrow-left-line fr-link--icon-left" href="' + (s ? '#/structure/' + s.id : '#/structures') + '">Retour</a></div>' + blocAlerte() +
      '<form class="an-form" data-form="structure" data-id="' + (id || 0) + '" data-cle="' + cle + '"><div class="an-grille">' +
      champ('sf-nom', 'Nom', b.Nom, { requis: true, attrs: a('Nom') }) +
      (aCol('Structures', 'Sigle') || DEMO ? champ('sf-sigle', 'Sigle', b.Sigle, { attrs: a('Sigle') }) : '') +
      (aCol('Structures', 'Type') || DEMO ? select('sf-type', 'Type', b.Type, typesStructure(), a('Type'), 'Non renseigné') : '') +
      (aCol('Structures', 'Parent') || DEMO ? select('sf-parent', 'Rattachée à', b.Parent, optionsStructures().filter(function (o) { return !exclus[o[0]]; }), a('Parent'), 'Aucune (structure de premier niveau)') : '') +
      ['Adresse', 'Courriel', 'Site'].filter(function (k) { return aCol('Structures', k) || DEMO; }).map(function (k) {
        return champ('sf-' + k.toLowerCase(), k === 'Site' ? 'Site internet' : k, b[k], { type: k === 'Courriel' ? 'email' : (k === 'Site' ? 'url' : 'text'), attrs: a(k), aide: k === 'Site' ? 'Adresse commençant par https://' : '' });
      }).join('') +
      '</div><ul class="fr-btns-group fr-btns-group--inline-md"><li><button class="fr-btn" type="submit">Enregistrer</button></li>' +
      '<li><a class="fr-btn fr-btn--secondary" href="' + (s ? '#/structure/' + s.id : '#/structures') + '" data-annuler="' + cle + '">Annuler</a></li></ul></form>';
    return h;
  }
  function champsStructureDepuisBrouillon(b) {
    var o = {};
    ['Nom', 'Sigle', 'Type', 'Adresse', 'Courriel', 'Site'].forEach(function (k) { if (aCol('Structures', k)) o[k] = String(b[k] || '').trim(); });
    if (aCol('Structures', 'Parent')) o.Parent = num(b.Parent);
    return o;
  }

  // ---------------------------------------------------------------------------
  // Vues : doublons et fusion
  // ---------------------------------------------------------------------------

  function miniFiche(p) {
    return '<div class="an-paire__fiche"><p class="fr-mb-1v"><a href="#/personne/' + p.id + '"><strong>' + esc(p.Nom) + '</strong></a>' + (archivee(p) ? ' ' + badge('Archivée') : '') + '</p>' +
      '<p class="fr-text--sm fr-mb-0">' + esc(emailDe(p) || 'Sans courriel') + '<br>' + esc(cheminStructure(p.Structure) || 'Sans structure') + (p.Fonction ? '<br>' + esc(p.Fonction) : '') +
      '<br><span class="an-raison">Citée ' + apparitions(p.id).length + ' fois</span></p></div>';
  }
  function vueDoublons() {
    var d = doublons();
    var h = navigation('doublons') + '<h1 class="fr-h3">Doublons probables <span class="an-compte">(' + d.length + ')</span></h1>' + blocAlerte() +
      '<p>Deux fiches sont proposées quand elles ont le même courriel ou le même nom (sans tenir compte des accents ni de l\'ordre des mots). Fusionner garde une fiche, y reporte toutes les mentions de l\'autre et archive celle-ci.</p>';
    if (!d.length) return h + '<p>Aucun doublon probable.</p>';
    return h + d.map(function (x) {
      return '<section class="an-paire" aria-label="' + esc(x.a.Nom + ' et ' + x.b.Nom) + '"><p class="an-raison">' + esc(x.raisons.join(', ')) + '</p>' +
        '<div class="an-paire__fiches">' + miniFiche(x.a) + miniFiche(x.b) + '</div>' +
        '<ul class="fr-btns-group fr-btns-group--inline-sm fr-btns-group--sm">' +
        '<li><a class="fr-btn" href="#/fusion/' + x.a.id + '/' + x.b.id + '">Garder la première</a></li>' +
        '<li><a class="fr-btn" href="#/fusion/' + x.b.id + '/' + x.a.id + '">Garder la seconde</a></li>' +
        '<li><button type="button" class="fr-btn fr-btn--tertiary" data-pas-doublon="' + x.cle + '">Ce ne sont pas des doublons</button></li></ul></section>';
    }).join('');
  }

  // Ce qu'une fusion change : champs complétés, références réécrites, mentions en texte.
  function planFusion(gid, aid) {
    var g = idx.Personnes[gid], a = idx.Personnes[aid], completer = {}, actions = [], refs = apparitions(aid).filter(function (r) { return !(r.table === 'Personnes' && r.col === 'Fusionne_dans'); });
    var cc = DEMO ? 'Email' : colCourriel();
    if (cc && !emailDe(g) && emailDe(a)) completer[cc] = emailDe(a);
    if (!num(g.Structure) && num(a.Structure)) completer.Structure = num(a.Structure);
    champsActifs().forEach(function (c) { var v = g[c.col], w = a[c.col]; if ((v === null || v === undefined || v === '' || (Array.isArray(v) && v.length < 2)) && !(w === null || w === undefined || w === '' || (Array.isArray(w) && w.length < 2))) completer[c.col] = w; });
    // Références réécrites, regroupées par table et colonne.
    var groupes = {};
    refs.forEach(function (r) {
      var k = r.table + '|' + r.col; (groupes[k] = groupes[k] || { table: r.table, col: r.col, mode: r.mode, ids: [], valeurs: [] });
      var v = r.mode === 'Ref' ? gid : ['L'].concat(liste(r.ligne[r.col]).map(num).map(function (x) { return x === aid ? gid : x; }).filter(function (x, i, t) { return t.indexOf(x) === i; }));
      groupes[k].ids.push(r.ligne.id); groupes[k].valeurs.push(v);
    });
    Object.keys(groupes).forEach(function (k) { var x = groupes[k], o = {}; o[x.col] = x.valeurs; actions.push(['BulkUpdateRecord', x.table, x.ids, o]); });
    if (Object.keys(completer).length) actions.push(['UpdateRecord', 'Personnes', gid, completer]);
    var fin = { Archive: true, Fusionne_dans: gid };
    if (aCol('Personnes', 'Archive_le') || DEMO) fin.Archive_le = aujourdhui();
    if (cc && emailDe(a)) fin[cc] = '';      // une adresse = une seule fiche
    if (a.Gestion_annuaire) fin.Gestion_annuaire = false;
    actions.push(['UpdateRecord', 'Personnes', aid, fin]);
    return { garde: g, absorbe: a, completer: completer, refs: refs, groupes: groupes, mentions: mentionsTexte(a.Nom), actions: actions };
  }
  function vueFusion(gid, aid) {
    var g = idx.Personnes[gid], a = idx.Personnes[aid];
    if (!g || !a || gid === aid) return navigation('doublons') + '<p>Fusion impossible : une des fiches n\'existe plus. <a href="#/doublons">Retour</a></p>';
    var pl = planFusion(gid, aid);
    var h = navigation('doublons') + '<div class="an-titre-ligne"><h1 class="fr-h3">Fusionner deux fiches</h1><a class="fr-link fr-icon-arrow-left-line fr-link--icon-left" href="#/doublons">Retour aux doublons</a></div>' + blocAlerte() +
      '<div class="an-paire__fiches"><div><h2 class="fr-h6">Fiche gardée</h2>' + miniFiche(g) + '</div><div><h2 class="fr-h6">Fiche fusionnée puis archivée</h2>' + miniFiche(a) + '</div></div>' +
      '<h2 class="fr-h5 fr-mt-3w">Ce qui va changer</h2><ul>';
    var comp = Object.keys(pl.completer);
    h += '<li>' + (comp.length ? 'La fiche gardée est complétée : ' + esc(comp.map(function (c) { return c === 'Email' || c === 'Email_saisi' ? 'courriel' : c.toLowerCase(); }).join(', ')) + '.' : 'La fiche gardée n\'est pas modifiée.') + '</li>';
    Object.keys(pl.groupes).forEach(function (k) { var x = pl.groupes[k]; h += '<li>' + esc(NOMS_TABLES[x.table] || x.table) + ' (' + esc(x.col) + ') : ' + x.ids.length + ' mention' + (x.ids.length > 1 ? 's' : '') + ' reportée' + (x.ids.length > 1 ? 's' : '') + ' sur la fiche gardée.</li>'; });
    h += '<li>La fiche « ' + esc(a.Nom) + ' » est archivée' + (emailDe(a) ? ', son courriel retiré' : '') + ' et elle renvoie vers la fiche gardée. Elle n\'est pas supprimée.</li>';
    if (pl.mentions.length) h += '<li>' + pl.mentions.length + ' mention' + (pl.mentions.length > 1 ? 's' : '') + ' du nom écrite' + (pl.mentions.length > 1 ? 's' : '') + ' en texte (' + esc(pl.mentions.map(function (m) { return NOMS_TABLES[m.table] || m.table; }).filter(function (x, i, t) { return t.indexOf(x) === i; }).join(', ')) + ') : vous pourrez les remplacer une à une depuis la fiche archivée.</li>';
    h += '</ul><p class="fr-text--sm">Si la fusion touche d\'autres tables que l\'annuaire (projets, groupes…), seul un propriétaire du document peut la faire.</p>' +
      '<ul class="fr-btns-group fr-btns-group--inline-md"><li><button type="button" class="fr-btn" data-fusionner="' + gid + ':' + aid + '">Fusionner</button></li>' +
      '<li><a class="fr-btn fr-btn--secondary" href="#/fusion/' + aid + '/' + gid + '">Garder plutôt l\'autre fiche</a></li></ul>';
    return h;
  }

  // ---------------------------------------------------------------------------
  // Vue : import d'un fichier CSV
  // ---------------------------------------------------------------------------

  function lireCsv(texte) {
    texte = String(texte || '').replace(/^﻿/, '');
    var premiere = texte.split(/\r?\n/)[0] || '';
    var sep = [';', ',', '\t'].map(function (s) { return [s, premiere.split(s).length]; }).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    var lignes = [], ligne = [], cell = '', guill = false;
    for (var i = 0; i < texte.length; i++) {
      var c = texte[i];
      if (guill) {
        if (c === '"' && texte[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') guill = false; else cell += c;
      } else if (c === '"') guill = true;
      else if (c === sep) { ligne.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && texte[i + 1] === '\n') i++; ligne.push(cell); cell = ''; if (ligne.some(function (x) { return x.trim(); })) lignes.push(ligne); ligne = []; }
      else cell += c;
    }
    ligne.push(cell); if (ligne.some(function (x) { return x.trim(); })) lignes.push(ligne);
    return { entetes: (lignes.shift() || []).map(function (x) { return x.trim(); }), lignes: lignes };
  }
  function champsImport() {
    return [['nomComplet', 'Nom complet'], ['prenom', 'Prénom'], ['nomFamille', 'Nom de famille'], ['email', 'Courriel'], ['structure', 'Structure (nom ou sigle)']]
      .concat(champsActifs().filter(function (c) { return c.type !== 'case'; }).map(function (c) { return [c.col, c.libelle]; }));
  }
  function deviner(entetes) {
    var corr = {}, cles = entetes.map(sansAccents);
    var regles = { nomComplet: /^(nom complet|nom et prenom|prenom nom|nom prenom|identite|agent|personne)$/, prenom: /^prenom$/, nomFamille: /^(nom|nom de famille|nom d.usage)$/,
      email: /(courriel|mail|e-mail|adresse electronique)/, structure: /(structure|service|etablissement|organisme|equipe|direction)/ };
    champsActifs().forEach(function (c) { regles[c.col] = new RegExp('^' + sansAccents(c.libelle).replace(/[^a-z0-9 ]/g, '.').split(' ')[0]); });
    Object.keys(regles).forEach(function (k) { var i = cles.findIndex(function (x) { return regles[k].test(x); }); if (i >= 0 && Object.keys(corr).map(function (z) { return corr[z]; }).indexOf(i) < 0) corr[k] = i; });
    if (corr.prenom !== undefined && corr.nomFamille === undefined) { var n = cles.indexOf('nom'); if (n >= 0) corr.nomFamille = n; }
    return corr;
  }
  function structureParNom(texte) {
    var c = sansAccents(texte).trim();
    if (!c) return null;
    return data.Structures.filter(function (s) { return sansAccents(s.Nom).trim() === c || (s.Sigle && sansAccents(s.Sigle).trim() === c); })[0] || null;
  }
  function analyserImport() {
    var imp = etat.imp, vus = {}, nomsVus = {};
    var val = function (l, k) { var i = imp.corr[k]; return i === undefined || i === '' ? '' : String(l[i] || '').trim(); };
    return imp.lignes.map(function (l, n) {
      var nom = val(l, 'nomComplet') || [val(l, 'prenom'), val(l, 'nomFamille')].filter(Boolean).join(' ');
      var email = val(l, 'email').toLowerCase(), r = { n: n + 2, nom: nom, email: email, structure: val(l, 'structure'), valeurs: {} };
      champsActifs().forEach(function (c) { if (imp.corr[c.col] !== undefined && imp.corr[c.col] !== '') r.valeurs[c.col] = val(l, c.col); });
      var cle = cleNom(nom);
      if (!nom) { r.statut = 'erreur'; r.raison = 'Nom manquant'; }
      else if (email && !courrielValide(email)) { r.statut = 'erreur'; r.raison = 'Courriel invalide'; }
      else if (email && (personneDe(email) || vus[email])) { r.statut = 'existe'; r.raison = vus[email] ? 'Même courriel plus haut dans le fichier' : 'Courriel déjà dans l\'annuaire'; }
      else if (data.Personnes.some(function (p) { return !num(p.Fusionne_dans) && cleNom(p.Nom) === cle; }) || nomsVus[cle]) { r.statut = 'doublon'; r.raison = 'Même nom déjà présent'; }
      else { r.statut = 'nouvelle'; r.raison = ''; }
      if (r.structure && !structureParNom(r.structure)) r.raison += (r.raison ? ' · ' : '') + 'structure inconnue';
      if (email) vus[email] = 1; if (cle) nomsVus[cle] = 1;
      return r;
    });
  }
  function vueImporter() {
    var h = navigation('importer') + '<h1 class="fr-h3">Importer des personnes</h1>' + blocAlerte() +
      '<p>Importez une liste depuis un tableur, enregistrée au format CSV (séparateur point-virgule ou virgule, première ligne = noms des colonnes). Rien n\'est écrit avant que vous cliquiez sur « Importer ». Réservé aux propriétaires et aux gestionnaires de l\'annuaire.</p>';
    var imp = etat.imp;
    h += '<div class="fr-upload-group fr-mb-3w"><label class="fr-label" for="imp-fichier">Fichier CSV<span class="fr-hint-text">Le fichier est lu dans votre navigateur ; il n\'est envoyé nulle part.</span></label>' +
      '<input class="fr-upload" type="file" id="imp-fichier" accept=".csv,text/csv,text/plain"></div>' +
      '<details class="fr-mb-3w"><summary>Ou coller le contenu</summary>' + champ('imp-texte', 'Contenu CSV', '', { multiligne: true, lignes: 6 }) +
      '<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary" data-action="lire-texte">Lire ce contenu</button></details>';
    if (!imp) return h;
    if (!imp.lignes.length) return h + '<p>Le fichier ne contient aucune ligne de données.</p>';
    h += '<h2 class="fr-h5">Correspondance des colonnes</h2><p class="fr-text--sm">' + imp.lignes.length + ' ligne(s) lue(s)' + (imp.nom ? ' dans ' + esc(imp.nom) : '') + '. Indiquez pour chaque champ la colonne du fichier. Un nom complet, ou un prénom et un nom, est obligatoire.</p><div class="an-filtres">' +
      champsImport().map(function (c) { return select('imp-c-' + c[0], c[1], imp.corr[c[0]] === undefined ? '' : imp.corr[c[0]], imp.entetes.map(function (e, i) { return [i, e || 'Colonne ' + (i + 1)]; }), 'data-corr="' + esc(c[0]) + '"', 'Ignorer'); }).join('') + '</div>' +
      '<div class="fr-checkbox-group fr-mb-1w"><input type="checkbox" id="imp-creer" data-imp-option="creer"' + (imp.creer ? ' checked' : '') + '><label class="fr-label" for="imp-creer">Créer les structures inconnues</label></div>' +
      '<div class="fr-checkbox-group fr-mb-2w"><input type="checkbox" id="imp-doub" data-imp-option="doublons"' + (imp.doublons ? ' checked' : '') + '><label class="fr-label" for="imp-doub">Importer aussi les doublons probables (même nom)<span class="fr-hint-text">Les lignes dont le courriel existe déjà ne sont jamais importées.</span></label></div>';
    var an = analyserImport(), comptes = { nouvelle: 0, doublon: 0, existe: 0, erreur: 0 };
    an.forEach(function (r) { comptes[r.statut]++; });
    var aImporter = comptes.nouvelle + (imp.doublons ? comptes.doublon : 0);
    h += '<h2 class="fr-h5">Aperçu</h2><p role="status">' + comptes.nouvelle + ' nouvelle(s), ' + comptes.doublon + ' doublon(s) probable(s), ' + comptes.existe + ' déjà présente(s), ' + comptes.erreur + ' en erreur.</p>' +
      '<div class="fr-table fr-table--sm an-table an-apercu-import"><div class="fr-table__wrapper"><div class="fr-table__container"><div class="fr-table__content"><table><caption class="fr-sr-only">Aperçu de l\'import</caption><thead><tr><th scope="col">Ligne</th><th scope="col">Nom</th><th scope="col">Courriel</th><th scope="col">Structure</th><th scope="col">Résultat</th></tr></thead><tbody>' +
      an.slice(0, 200).map(function (r) {
        var lib = { nouvelle: 'Sera ajoutée', doublon: imp.doublons ? 'Sera ajoutée (doublon probable)' : 'Ignorée : doublon probable', existe: 'Ignorée', erreur: 'Erreur' }[r.statut];
        return '<tr><td>' + r.n + '</td><td>' + esc(r.nom) + '</td><td>' + esc(r.email) + '</td><td>' + esc(r.structure) + '</td><td' + (r.statut === 'erreur' ? ' class="an-ko"' : '') + '>' + esc(lib + (r.raison ? ' (' + r.raison + ')' : '')) + '</td></tr>';
      }).join('') + '</tbody></table></div></div></div></div>' + (an.length > 200 ? '<p class="fr-text--sm">Seules les 200 premières lignes sont affichées.</p>' : '') +
      '<ul class="fr-btns-group fr-btns-group--inline-md fr-mt-2w"><li><button type="button" class="fr-btn" data-action="importer"' + (aImporter ? '' : ' disabled') + '>Importer ' + aImporter + ' personne(s)</button></li>' +
      '<li><button type="button" class="fr-btn fr-btn--secondary" data-action="abandonner-import">Abandonner</button></li></ul>';
    return h;
  }
  function importer() {
    var imp = etat.imp, an = analyserImport().filter(function (r) { return r.statut === 'nouvelle' || (imp.doublons && r.statut === 'doublon'); });
    if (!an.length) return;
    var nouvelles = {}, structures = [];
    if (imp.creer) an.forEach(function (r) { if (r.structure && !structureParNom(r.structure) && !nouvelles[sansAccents(r.structure).trim()]) { nouvelles[sansAccents(r.structure).trim()] = 1; structures.push(r.structure); } });
    var etape = structures.length && aCol('Structures', 'Nom')
      ? ecrire([['BulkAddRecord', 'Structures', structures.map(function () { return null; }), { Nom: structures }]]).then(function () { return DEMO ? null : chargerGrist().then(indexer); })
      : Promise.resolve();
    etape.then(function () {
      var cc = DEMO ? 'Email' : colCourriel(), cols = { Nom: [] };
      if (cc) cols[cc] = [];
      if (aCol('Personnes', 'Structure')) cols.Structure = [];
      var persos = champsActifs().filter(function (c) { return imp.corr[c.col] !== undefined && imp.corr[c.col] !== ''; });
      persos.forEach(function (c) { cols[c.col] = []; });
      an.forEach(function (r) {
        cols.Nom.push(r.nom);
        if (cc) cols[cc].push(r.email);
        if (cols.Structure) { var s = structureParNom(r.structure); cols.Structure.push(s ? s.id : 0); }
        persos.forEach(function (c) {
          var v = r.valeurs[c.col] || '';
          if (c.type === 'nombre') v = v === '' ? null : Number(String(v).replace(',', '.'));
          else if (c.type === 'date') { var m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); v = m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) / 1000 : saisieVersDate(v); }
          else if (c.type === 'choixMultiple') v = ['L'].concat(String(v).split(/[,;]/).map(function (x) { return x.trim(); }).filter(Boolean));
          cols[c.col].push(v);
        });
      });
      return ecrire([['BulkAddRecord', 'Personnes', an.map(function () { return null; }), cols]]);
    }).then(function () {
      etat.imp = null; etat.garderAlerte = true;
      etat.alerte = { type: 'success', texte: an.length + ' personne(s) importée(s)' + (structures.length ? ', ' + structures.length + ' structure(s) créée(s)' : '') + '.' };
      return DEMO ? null : charger();
    }).then(function () { location.hash = '#/'; rendre(); }).catch(function (err) {
      etat.alerte = { type: 'error', texte: messageRefus(err, 'Import impossible.') }; rendre();
    });
  }

  // ---------------------------------------------------------------------------
  // Configuration : réglages propres à l'annuaire
  // ---------------------------------------------------------------------------

  var brouillonReglages = null, configLab = null, avantApercu = null;
  function slug(libelle) {
    var s = sansAccents(libelle).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).map(function (m, i) { return i ? m : m.charAt(0).toUpperCase() + m.slice(1); }).join('_');
    if (!s || /^\d/.test(s)) s = 'Champ_' + s;
    return s.slice(0, 40);
  }
  function reglagesPropres() {
    var b = brouillonReglages; b.champs = b.champs || {}; b.champsPerso = b.champsPerso || [];
    var h = '<div class="cl-panneau"><p class="fr-text--sm">Réservé aux propriétaires du document. Les réglages sont enregistrés dans la description de la colonne <code>' + NOM_COLONNE_CONFIG + '</code> de la table Personnes.</p>' +
      '<h2 class="fr-h5">Champs prévus</h2><p class="fr-text--sm">Nom, courriel et structure sont toujours présents. Un champ désactivé est masqué ; ses données restent dans Grist.</p>';
    CHAMPS_PREVUS.forEach(function (c) {
      var v = b.champs[c[0]] === undefined ? c[3] : !!b.champs[c[0]];
      h += '<div class="fr-checkbox-group fr-mb-1w"><input type="checkbox" id="rg-ch-' + c[0] + '" data-rg-champ="' + c[0] + '"' + (v ? ' checked' : '') + '><label class="fr-label" for="rg-ch-' + c[0] + '">' + esc(c[1]) + '<span class="fr-hint-text">Colonne Personnes.' + c[2] + (aCol('Personnes', c[2]) || DEMO ? '' : ', créée à l\'enregistrement') + '</span></label></div>';
    });
    h += '<h2 class="fr-h5 fr-mt-3w">Champs personnalisés</h2><p class="fr-text--sm">Ajoutez les informations utiles à votre usage (compétences, équipe, référent, date d\'arrivée…). Chaque champ devient une colonne de la table Personnes. ' +
      'N\'ajoutez que des informations professionnelles nécessaires : pas de données sensibles (santé, opinions, vie privée).</p>';
    b.champsPerso.forEach(function (c, i) {
      h += '<div class="an-champ-perso"><div class="an-grille">' +
        champ('rg-p-lib-' + i, 'Libellé', c.libelle || '', { attrs: 'data-rg-perso="' + i + '" data-cle="libelle"' + (c.col && (aCol('Personnes', c.col) || DEMO) ? '' : ''), aide: c.col ? 'Colonne Personnes.' + c.col : 'La colonne sera nommée à l\'enregistrement.' }) +
        select('rg-p-type-' + i, 'Type', c.type || 'texte', TYPES_PERSO.map(function (t) { return [t[0], t[1]]; }), 'data-rg-perso="' + i + '" data-cle="type"' + (c.col && aCol('Personnes', c.col) ? ' disabled' : '')) +
        (c.type === 'choix' || c.type === 'choixMultiple' ? champ('rg-p-opt-' + i, 'Valeurs possibles (une par ligne)', (c.options || []).join('\n'), { multiligne: true, lignes: 4, attrs: 'data-rg-perso="' + i + '" data-cle="options"', classe: 'an-large' }) : '') +
        '<div class="fr-checkbox-group"><input type="checkbox" id="rg-p-mas-' + i + '" data-rg-perso="' + i + '" data-cle="masque"' + (c.masque ? ' checked' : '') + '><label class="fr-label" for="rg-p-mas-' + i + '">Masquer ce champ</label></div>' +
        (c.col && aCol('Personnes', c.col) ? '' : '<button type="button" class="fr-btn fr-btn--sm fr-btn--tertiary" data-rg-retirer="' + i + '">Retirer</button>') +
        '</div></div>';
    });
    h += '<button type="button" class="fr-btn fr-btn--sm fr-btn--secondary fr-icon-add-line fr-btn--icon-left" data-rg-ajouter>Ajouter un champ</button>';
    h += '<h2 class="fr-h5 fr-mt-3w">Types de structures</h2>' + champ('rg-types', 'Une valeur par ligne', ((b.listes && b.listes.typesStructure) || typesStructure()).join('\n'), { multiligne: true, lignes: 5, aide: 'Colonne Structures.Type' });
    h += '<h2 class="fr-h5 fr-mt-3w">Protection des données</h2>' +
      champ('rg-purge', 'Délai de conservation après archivage (mois)', b.purgeMois === undefined ? 12 : b.purgeMois, { type: 'number', attrs: 'min="0" max="120"', aide: 'Les fiches archivées depuis plus longtemps sont proposées à la suppression (filtre « Statut »). 0 : jamais. Rien n\'est supprimé sans votre action.' }) +
      champ('rg-mention', 'Mention d\'information', typeof b.mention === 'string' ? b.mention : MENTION_DEFAUT, { multiligne: true, lignes: 6, aide: 'Affichée en bas de l\'annuaire et des fiches. À faire valider par le délégué à la protection des données de votre organisation.' });
    h += '<h2 class="fr-h5 fr-mt-3w">Règles d\'accès</h2>' + blocRegles() + '</div>';
    return h;
  }
  function lireReglages(b) {
    var d = JSON.parse(JSON.stringify(b || {}));
    d.champs = d.champs || {}; d.champsPerso = d.champsPerso || []; d.listes = d.listes || {};
    var q = function (id) { return document.getElementById(id); };
    CHAMPS_PREVUS.forEach(function (c) { var n = q('rg-ch-' + c[0]); if (n) d.champs[c[0]] = n.checked; });
    d.champsPerso.forEach(function (c, i) {
      var l = q('rg-p-lib-' + i), t = q('rg-p-type-' + i), o = q('rg-p-opt-' + i), m = q('rg-p-mas-' + i);
      if (l) c.libelle = l.value.trim(); if (t && !t.disabled) c.type = t.value;
      if (o) c.options = o.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      if (m) c.masque = m.checked;
    });
    d.champsPerso = d.champsPerso.filter(function (c) { return c.libelle; });
    var t = q('rg-types');
    if (t) { var v = t.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean); if (v.length) d.listes.typesStructure = v; }
    var pu = q('rg-purge'); if (pu) d.purgeMois = Math.max(0, num(pu.value));
    var me = q('rg-mention'); if (me) d.mention = me.value.trim();
    // Nom de colonne des champs nouveaux, unique.
    var pris = {}; meta.colonnes.forEach(function (c) { if (table('Personnes') && c.parentId === table('Personnes').id) pris[c.colId.toLowerCase()] = 1; });
    d.champsPerso.forEach(function (c) { if (c.col) pris[c.col.toLowerCase()] = 1; });
    d.champsPerso.forEach(function (c) {
      if (c.col) return;
      var base = slug(c.libelle), n = base, k = 2;
      while (pris[n.toLowerCase()]) n = base + '_' + (k++);
      pris[n.toLowerCase()] = 1; c.col = n;
    });
    return d;
  }
  function typeGrist(t) { return (TYPES_PERSO.filter(function (x) { return x[0] === t; })[0] || TYPES_PERSO[0])[2]; }
  function enregistrerReglages() {
    var b = lireReglages(brouillonReglages);
    if (DEMO) {
      var tp = table('Personnes');
      b.champsPerso.forEach(function (c) { if (!aCol('Personnes', c.col)) meta.colonnes.push({ id: meta.colonnes.length + 100, parentId: tp.id, colId: c.col, type: typeGrist(c.type), isFormula: false, formula: '', widgetOptions: '' }); });
      appliquerReglages(b); brouillonReglages = b; if (configLab) { configLab.rafraichir('reglages'); configLab.message('info', 'Mode démonstration : rien n\'est enregistré. Dans Grist, les réglages sont enregistrés dans le document.'); } rendre(); return; }
    if (!table('Personnes')) { if (configLab) configLab.message('error', 'Installez d\'abord l\'annuaire (onglet Annuaire).'); return; }
    var actions = [];
    if (!aCol('Personnes', NOM_COLONNE_CONFIG)) actions.push(['AddColumn', 'Personnes', NOM_COLONNE_CONFIG, { type: 'Text', label: NOM_COLONNE_CONFIG }]);
    actions.push(['ModifyColumn', 'Personnes', NOM_COLONNE_CONFIG, { description: JSON.stringify(b) }]);
    CHAMPS_PREVUS.forEach(function (c) { if (b.champs[c[0]] && !aCol('Personnes', c[2])) actions.push(['AddColumn', 'Personnes', c[2], { type: 'Text', label: c[2] }]); });
    b.champsPerso.forEach(function (c) {
      var opts = (c.type === 'choix' || c.type === 'choixMultiple') ? JSON.stringify({ choices: c.options || [] }) : (c.type === 'texteLong' ? JSON.stringify({ wrap: true }) : '');
      var existe = col('Personnes', c.col);
      if (!existe) actions.push(['AddColumn', 'Personnes', c.col, Object.assign({ type: typeGrist(c.type), label: c.libelle }, opts ? { widgetOptions: opts } : {})]);
      else if (opts && /^Choice/.test(existe.type)) {
        var o = {}; try { o = JSON.parse(existe.widgetOptions || '{}'); } catch (e) { o = {}; }
        o.choices = c.options || []; actions.push(['ModifyColumn', 'Personnes', c.col, { widgetOptions: JSON.stringify(o) }]);
      }
    });
    var ct = col('Structures', 'Type');
    if (ct && /^Choice/.test(ct.type) && b.listes.typesStructure) {
      var o = {}; try { o = JSON.parse(ct.widgetOptions || '{}'); } catch (e) { o = {}; }
      o.choices = b.listes.typesStructure; actions.push(['ModifyColumn', 'Structures', 'Type', { widgetOptions: JSON.stringify(o) }]);
    }
    grist.docApi.applyUserActions(actions).then(function () {
      brouillonReglages = b;
      return charger();
    }).then(function () {
      if (configLab) { configLab.enregistre(); configLab.rafraichir('reglages'); configLab.message('success', 'Réglages enregistrés.'); }
      rendre();
    }).catch(function (err) {
      if (configLab) configLab.message('error', 'Enregistrement impossible : seuls les propriétaires du document peuvent modifier les réglages. (' + ((err && err.message) || err) + ')');
    });
  }
  function monterCoque() {
    var z = document.getElementById('an-coque');
    if (configLab || !z || !window.ConfigLab) return;
    brouillonReglages = JSON.parse(JSON.stringify(reglages || {}));
    brouillonReglages.page = brouillonReglages.page || { marque: '', titre: 'Annuaire', pied: { accessibilite: '' } };
    configLab = window.ConfigLab.monter(z, {
      nom: 'Widget annuaire',
      vue: { libelle: 'Annuaire', element: app },
      ongletInitial: route().vue === 'reglages' ? 'reglages' : 'vue',
      page: brouillonReglages.page,
      onglets: [{ id: 'reglages', libelle: 'Réglages', rendre: function (zone) { zone.innerHTML = reglagesPropres(); } }],
      surApercu: function (ouvert) {
        if (ouvert && configLab && configLab.estModifie() && brouillonReglages) {
          avantApercu = reglages; appliquerReglages(lireReglages(brouillonReglages)); rendre();
        } else if (!ouvert && avantApercu) { appliquerReglages(avantApercu); avantApercu = null; rendre(); }
      },
      publication: { mode: 'connecte', adresseWidget: location.href.split('#')[0].split('?')[0],
        texte: 'L\'annuaire n\'a pas de page publique : il contient des données personnelles. Il s\'utilise dans Grist, par les personnes invitées dans le document, selon leurs droits ' +
          '(propriétaires et gestionnaires de l\'annuaire : tout ; éditeurs : leur fiche et celles qu\'ils ont créées ; lecteurs : consultation). Pour montrer des structures au public, utilisez grist-carte sur la table Structures.' },
      surEnregistrer: enregistrerReglages
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-rg-ajouter],[data-rg-retirer],[data-action="installer-regles"]');
    if (!t || !brouillonReglages) return;
    if (t.matches('[data-action="installer-regles"]')) { installerRegles(); return; }
    brouillonReglages = lireReglages(brouillonReglages);
    if (t.hasAttribute('data-rg-ajouter')) brouillonReglages.champsPerso.push({ libelle: 'Nouveau champ', type: 'texte' });
    else brouillonReglages.champsPerso.splice(num(t.getAttribute('data-rg-retirer')), 1);
    // Les champs sans colonne encore créée gardent un nom provisoire : on l'efface pour le recalculer.
    brouillonReglages.champsPerso.forEach(function (c) { if (c.col && !aCol('Personnes', c.col) && !DEMO) delete c.col; });
    if (configLab) { configLab.modifie(true); configLab.rafraichir('reglages'); }
  });
  document.addEventListener('change', function (e) {
    var t = e.target.closest('[data-rg-perso][data-cle="type"]');
    if (!t || !brouillonReglages) return;
    brouillonReglages = lireReglages(brouillonReglages);
    brouillonReglages.champsPerso.forEach(function (c) { if (c.col && !aCol('Personnes', c.col) && !DEMO) delete c.col; });
    if (configLab) configLab.rafraichir('reglages');
  });

  // ---------------------------------------------------------------------------
  // Installation, mise à jour du document et règles d'accès
  // ---------------------------------------------------------------------------

  function choix(l) { return { type: 'Choice', widgetOptions: JSON.stringify({ choices: l }) }; }
  var COL_CREE_PAR = { type: 'Text', isFormula: false, formula: '(user.Email or "").strip().lower()' };
  var COL_CREE_LE = { type: 'DateTime:Europe/Paris', isFormula: false, formula: 'NOW()' };
  function schemaStructures() {
    return [['Nom', { type: 'Text' }], ['Sigle', { type: 'Text' }], ['Type', choix(typesStructure())], ['Parent', { type: 'Ref:Structures' }],
      ['Adresse', { type: 'Text' }], ['Courriel', { type: 'Text' }], ['Site', { type: 'Text' }]];
  }
  function schemaPersonnes() {
    return [['Nom', { type: 'Text' }], ['Email', { type: 'Text' }], ['Structure', { type: 'Ref:Structures' }], ['Fonction', { type: 'Text' }],
      ['Archive', { type: 'Bool' }], ['Archive_le', { type: 'Date' }], ['Fusionne_dans', { type: 'Ref:Personnes' }], ['Gestion_annuaire', { type: 'Bool' }],
      ['Cree_par', COL_CREE_PAR], ['Cree_le', COL_CREE_LE], [NOM_COLONNE_CONFIG, { type: 'Text' }]];
  }
  function schemaComptes() { return [['Email', { type: 'Text', isFormula: false, formula: '(user.Email or "").strip().lower()' }], ['Cree_le', COL_CREE_LE]]; }
  function fiche(t, cols) { return ['AddTable', t, cols.map(function (c) { return Object.assign({ id: c[0] }, c[1]); })]; }

  function vueInstallation() {
    return '<h1 class="fr-h3">Installer l\'annuaire dans ce document</h1>' + blocAlerte() +
      '<p>L\'annuaire gère les tables <code>Personnes</code> et <code>Structures</code> du document, que les autres widgets peuvent lire. Ce document n\'a pas encore de table <code>Personnes</code> : le widget peut la créer, avec <code>Structures</code> et <code>Comptes</code> (qui sert à reconnaître la personne connectée), puis poser les règles d\'accès.</p>' +
      '<p class="fr-text--sm">À faire par un propriétaire du document. Le widget doit avoir l\'accès complet au document.</p>' +
      '<ul class="fr-btns-group fr-btns-group--inline-md"><li><button type="button" class="fr-btn" data-installer="vide">Créer les tables</button></li>' +
      '<li><button type="button" class="fr-btn fr-btn--secondary" data-installer="exemple">Créer les tables avec un exemple fictif</button></li></ul>';
  }
  function installer(avecExemple) {
    var actions = [];
    if (!table('Structures')) actions.push(fiche('Structures', schemaStructures()));
    actions.push(fiche('Personnes', schemaPersonnes()));
    if (!table('Comptes')) actions.push(fiche('Comptes', schemaComptes()));
    grist.docApi.applyUserActions(actions).then(chargerGrist).then(afficherReferences).then(function () {
      if (!avecExemple) return null;
      return fetch('exemples/demo.json').then(function (r) { return r.json(); }).then(function (json) {
        var st = json.Structures, ps = json.Personnes.slice(0, 24);
        var cs = { Nom: st.map(function (s) { return s.Nom; }), Sigle: st.map(function (s) { return s.Sigle || ''; }), Type: st.map(function (s) { return s.Type || null; }) };
        return grist.docApi.applyUserActions([['BulkAddRecord', 'Structures', st.map(function () { return null; }), cs]]).then(function (r) {
          var ids = r.retValues[0], carte = {}; st.forEach(function (s, i) { carte[s.id] = ids[i]; });
          return grist.docApi.applyUserActions([
            ['BulkUpdateRecord', 'Structures', ids, { Parent: st.map(function (s) { return carte[s.Parent] || 0; }) }],
            ['BulkAddRecord', 'Personnes', ps.map(function () { return null; }), { Nom: ps.map(function (p) { return p.Nom; }), Email: ps.map(function (p) { return p.Email || ''; }),
              Structure: ps.map(function (p) { return carte[p.Structure] || 0; }), Fonction: ps.map(function (p) { return p.Fonction || ''; }) }]]);
        });
      });
    }).then(function () { return installerRegles(true); }).then(function () {
      etat.alerte = { type: 'success', texte: 'Annuaire installé, avec ses règles d\'accès.' + (avecExemple ? ' L\'exemple fictif est chargé : supprimez ses fiches quand vous voulez.' : '') };
      return charger();
    }).then(rendre).catch(function (err) {
      etat.alerte = { type: 'error', texte: messageRefus(err, 'Installation impossible : seuls les propriétaires du document peuvent créer des tables.') };
      charger().then(rendre, rendre);
    });
  }
  // Les références affichent un libellé lisible plutôt qu'un numéro.
  function afficherReferences() {
    var aff = [];
    [['Personnes', 'Structure', 'Structures', 'Nom'], ['Personnes', 'Fusionne_dans', 'Personnes', 'Nom'], ['Structures', 'Parent', 'Structures', 'Nom']].forEach(function (r) {
      var c = col(r[0], r[1]), v = col(r[2], r[3]);
      if (c && v && !c.visibleCol) { aff.push(['ModifyColumn', r[0], r[1], { visibleCol: v.id }]); aff.push(['SetDisplayFormula', r[0], null, c.id, '$' + r[1] + '.' + r[3]]); }
    });
    return aff.length ? grist.docApi.applyUserActions(aff) : null;
  }
  function mettreAJour() {
    var actions = [];
    if (!table('Structures')) actions.push(fiche('Structures', schemaStructures()));
    else schemaStructures().forEach(function (c) { if (!aCol('Structures', c[0])) actions.push(['AddColumn', 'Structures', c[0], c[1]]); });
    var sp = schemaPersonnes();
    sp.forEach(function (c) {
      if (aCol('Personnes', c[0])) return;
      if (c[0] === 'Email' && (aCol('Personnes', 'Email_saisi'))) return;
      if (c[0] === 'Cree_le' && aCol('Personnes', 'Cree_le')) return;
      actions.push(['AddColumn', 'Personnes', c[0], c[1]]);
    });
    if (!table('Comptes')) actions.push(fiche('Comptes', schemaComptes()));
    grist.docApi.applyUserActions(actions).then(chargerGrist).then(afficherReferences).then(function () {
      etat.alerte = { type: 'success', texte: 'Document mis à jour : ' + actions.length + ' élément(s) ajouté(s). Vérifiez ensuite les règles d\'accès dans l\'onglet Réglages.' };
      return charger();
    }).then(rendre).catch(function (err) {
      etat.alerte = { type: 'error', texte: messageRefus(err, 'Mise à jour impossible : seuls les propriétaires du document peuvent ajouter des colonnes.') }; rendre();
    });
  }

  // Règles d'accès. Un attribut utilisateur relie la personne connectée à sa fiche (par le courriel),
  // ce qui permet d'accorder le rôle « gestionnaire de l'annuaire » à des éditeurs.
  var MEMO = 'grist-annuaire';
  var GEST = 'user.Access in [EDITOR] and user.' + ATTRIBUT + '.Gestion_annuaire';
  function reglesAnnuaire() {
    return {
      Personnes: [
        ['user.Access not in [OWNER] and newRec.Gestion_annuaire', '-CU', 'Rôle gestionnaire de l’annuaire : attribué par les propriétaires', true],
        ['user.Access not in [OWNER] and rec.Gestion_annuaire', '-UD', 'Fiche d’un gestionnaire : propriétaires seulement', true],
        ['user.Access in [OWNER]', '+CRUDS', 'Propriétaires : tout'],
        [GEST, '+CRUD', 'Gestionnaires de l’annuaire : toutes les fiches', true],
        ['user.Access in [EDITOR] and (rec.Cree_par == user.Email.lower() or (rec.Email and rec.Email.lower() == user.Email.lower()))', '+RU', 'Éditeurs : leur fiche et celles qu’ils ont créées'],
        ['user.Access in [EDITOR]', '+RC', 'Éditeurs : consultent et créent des fiches'],
        ['user.Access in [VIEWER] and user.Email != "anon@getgrist.com"', '+R', 'Lecteurs connectés : consultent (jamais un visiteur anonyme, même si le document est public)'],
        ['True', '-CRUDS', 'Vos droits sur ce document ne permettent pas cette action.']],
      Structures: [
        ['user.Access in [OWNER]', '+CRUDS', 'Propriétaires : tout'],
        [GEST, '+CRUD', 'Gestionnaires de l’annuaire : les structures', true],
        ['user.Access in [EDITOR, VIEWER]', '+R', 'Consultation'],
        ['True', '-CRUDS', 'Vos droits sur ce document ne permettent pas cette action.']],
      Comptes: [
        ['rec.Email and rec.Email != user.Email.lower()', '-RU', 'Chacun ne voit que sa ligne'],
        ['user.Access in [EDITOR] and newRec.Email and newRec.Email != user.Email.lower()', '-CU', 'Pas de compte au nom d’un autre'],
        ['user.Access in [OWNER]', '+CRUD', 'Propriétaires : nettoient les comptes'],
        ['user.Access in [EDITOR]', '+CRU', 'Éditeurs : créent leur ligne'],
        ['True', '-CRUD', 'Vos droits sur ce document ne permettent pas cette action.']]
    };
  }
  var etatRegles = null;   // { attribut, Personnes: 'aucune'|'annuaire'|'autres'|'completes', … }
  function lireRegles() {
    if (DEMO) { etatRegles = { demo: true }; return Promise.resolve(etatRegles); }
    return Promise.all([grist.docApi.fetchTable('_grist_ACLResources'), grist.docApi.fetchTable('_grist_ACLRules')]).then(function (m) {
      var res = lignesDepuisColonnes(m[0]), regles = lignesDepuisColonnes(m[1]);
      var e = { res: res, regles: regles, attribut: regles.some(function (r) { return r.userAttributes && JSON.parse(r.userAttributes).name === ATTRIBUT; }) };
      ['Personnes', 'Structures', 'Comptes'].forEach(function (t) {
        var ids = res.filter(function (r) { return r.tableId === t; }).map(function (r) { return r.id; });
        var rs = regles.filter(function (r) { return ids.indexOf(r.resource) >= 0; });
        e[t] = !rs.length ? 'aucune' : (rs.some(function (r) { return String(r.memo || '').indexOf('Gestionnaires de l’annuaire') === 0; }) ? 'annuaire' : 'autres');
      });
      etatRegles = e; return e;
    }).catch(function () { etatRegles = { illisible: true }; return etatRegles; });
  }
  function blocRegles() {
    var e = etatRegles;
    if (!e) { lireRegles().then(function () { if (configLab) configLab.rafraichir('reglages'); }); return '<p class="fr-text--sm">Lecture des règles…</p>'; }
    if (e.demo) return '<p class="fr-text--sm">Dans Grist, cette rubrique montre l\'état des règles d\'accès de Personnes, Structures et Comptes et propose de les installer.</p>';
    if (e.illisible) return '<p class="fr-text--sm">Seuls les propriétaires du document voient les règles d\'accès.</p>';
    var lib = { aucune: 'aucune règle', annuaire: 'règles de l\'annuaire en place', autres: 'règles d\'un autre outil (par exemple grist-projet), sans le rôle gestionnaire' };
    var libT = function (t) { return t === 'Comptes' && e[t] === 'autres' ? 'règles d\'un autre outil, gardées' : lib[e[t]]; };
    var aFaire = !e.attribut || ['Personnes', 'Structures', 'Comptes'].some(function (t) { return e[t] !== 'annuaire' && !(t === 'Comptes' && e[t] === 'autres'); });
    return '<ul class="fr-text--sm">' + ['Personnes', 'Structures', 'Comptes'].map(function (t) { return '<li><code>' + t + '</code> : ' + libT(t) + '</li>'; }).join('') + '</ul>' +
      '<p class="fr-text--sm">Les règles de l\'annuaire : propriétaires et gestionnaires de l\'annuaire gèrent tout ; les éditeurs consultent, créent des fiches et modifient la leur et celles qu\'ils ont créées ; les lecteurs connectés consultent ; une personne sans accès au document, ou un visiteur anonyme d\'un document public, ne voit aucune personne. ' +
      'Des règles déjà posées par un autre outil sont gardées : l\'annuaire y ajoute seulement le rôle gestionnaire.</p>' +
      (aFaire ? '<button type="button" class="fr-btn fr-btn--sm" data-action="installer-regles">' + (['Personnes', 'Structures'].every(function (t) { return e[t] === 'aucune'; }) ? 'Installer les règles d\'accès' : 'Compléter les règles d\'accès') + '</button>' : '<p class="fr-badge fr-badge--success fr-badge--sm">Règles en place</p>');
  }
  function installerRegles(silencieux) {
    if (DEMO) return Promise.resolve();
    if (!aCol('Personnes', 'Gestion_annuaire') || !aCol('Personnes', 'Cree_par')) {
      if (!silencieux && configLab) configLab.message('error', 'Mettez d\'abord le document à jour (bandeau de l\'onglet Annuaire).');
      return Promise.resolve();
    }
    return lireRegles().then(function (e) {
      if (e.illisible) throw new Error('règles illisibles');
      var ajoutsRes = [], plan = [], R0 = reglesAnnuaire();
      var ressource = function (t, c) { var r = e.res.filter(function (x) { return x.tableId === t && x.colIds === c; })[0]; return r ? r.id : null; };
      var aCreer = function (t, c) { var k = t + '|' + c; if (ajoutsRes.indexOf(k) < 0) ajoutsRes.push(k); return k; };
      if (!e.attribut) {
        var etoile = ressource('*', '*');
        plan.push({ res: etoile || aCreer('*', '*'), pos: 1, formule: '', droits: '', memo: '', attr: JSON.stringify({ name: ATTRIBUT, tableId: 'Personnes', lookupColId: 'Email', charId: 'Email' }) });
      }
      ['Personnes', 'Structures', 'Comptes'].forEach(function (t) {
        if (e[t] === 'annuaire') return;
        var rid = ressource(t, '*');
        var existantes = rid ? e.regles.filter(function (r) { return r.resource === rid; }).sort(function (a, b) { return (a.rulePos || 0) - (b.rulePos || 0); }) : [];
        if (e[t] === 'aucune' || !existantes.length) {
          if (e[t] !== 'aucune' && t === 'Comptes') return;
          var base = e.regles.reduce(function (m, r) { return Math.max(m, r.rulePos || 0); }, 0) + 1;
          R0[t].forEach(function (r, i) { plan.push({ res: rid || aCreer(t, '*'), pos: base + i, formule: r[0], droits: r[1], memo: r[2] }); });
          return;
        }
        if (t === 'Comptes') return;
        // Règles d'un autre outil : ajout des seules règles du rôle gestionnaire, juste avant la première règle qui accorde un droit.
        var i0 = existantes.findIndex(function (r) { return /^\+/.test(r.permissionsText || ''); });
        if (i0 < 0) i0 = existantes.length - 1;
        var apres = existantes[i0].rulePos || 0, avant = i0 > 0 ? (existantes[i0 - 1].rulePos || 0) : apres - 1;
        var nouvelles = R0[t].filter(function (r) { return r[3]; });
        nouvelles.forEach(function (r, k) { plan.push({ res: rid, pos: avant + (apres - avant) * (k + 1) / (nouvelles.length + 1), formule: r[0], droits: r[1], memo: r[2] }); });
        // Colonnes du courriel protégées par une règle de colonne : les gestionnaires peuvent les corriger.
        e.res.filter(function (x) { return x.tableId === 'Personnes' && /(^|,)Email/.test(x.colIds) && x.colIds !== '*'; }).forEach(function (x) {
          if (t !== 'Personnes') return;
          var rc = e.regles.filter(function (r) { return r.resource === x.id; }).sort(function (a, b) { return (a.rulePos || 0) - (b.rulePos || 0); });
          var p0 = rc.length ? (rc[0].rulePos || 0) - 0.5 : 1;
          plan.push({ res: x.id, pos: p0, formule: GEST, droits: '+RU', memo: 'Gestionnaires de l’annuaire : corrigent les courriels' });
        });
      });
      if (!plan.length) return null;
      // Une seule action : Grist recharge le document (et le widget) dès que les règles changent.
      // Les ressources nouvelles sont désignées par des numéros négatifs, résolus dans la même action.
      var neg = {}; ajoutsRes.forEach(function (k, i) { neg[k] = -(i + 1); });
      var actions = [];
      if (ajoutsRes.length) actions.push(['BulkAddRecord', '_grist_ACLResources', ajoutsRes.map(function (k) { return neg[k]; }), {
        tableId: ajoutsRes.map(function (k) { return k.split('|')[0]; }), colIds: ajoutsRes.map(function (k) { return k.split('|')[1]; }) }]);
      actions.push(['BulkAddRecord', '_grist_ACLRules', plan.map(function () { return null; }), {
        resource: plan.map(function (p) { return typeof p.res === 'string' ? neg[p.res] : p.res; }),
        aclFormula: plan.map(function (p) { return p.formule; }), permissionsText: plan.map(function (p) { return p.droits; }),
        rulePos: plan.map(function (p) { return p.pos; }), memo: plan.map(function (p) { return p.memo; }), userAttributes: plan.map(function (p) { return p.attr || ''; })
      }]);
      try { sessionStorage.setItem('an-regles', '1'); } catch (er) { /* stockage indisponible */ }
      return grist.docApi.applyUserActions(actions).then(function () {
        try { sessionStorage.removeItem('an-regles'); } catch (er) { /* stockage indisponible */ }
      }).catch(function (err) {
        // Le rechargement du document après un changement de règles coupe la connexion : ce n'est pas un échec.
        if (/disposed|closed|disconnect/i.test(String((err && err.message) || err))) return null;
        try { sessionStorage.removeItem('an-regles'); } catch (er) { /* stockage indisponible */ }
        throw err;
      });
    }).then(function () {
      etatRegles = null;
      if (!silencieux && configLab) { configLab.rafraichir('reglages'); configLab.message('success', 'Règles d\'accès installées. Vous pouvez les voir dans Grist : menu Règles d\'accès.'); }
    }).catch(function (err) {
      if (silencieux) throw err;
      if (configLab) configLab.message('error', 'Règles non installées : seuls les propriétaires du document peuvent modifier les règles d\'accès. (' + ((err && err.message) || err) + ')');
    });
  }

  // ---------------------------------------------------------------------------
  // Rendu
  // ---------------------------------------------------------------------------

  function rendre() {
    var r = route(), html;
    monterCoque();
    if (configLab && etat.alerte && configLab.ongletActif() !== 'vue' && configLab.ongletActif() !== 'apercu') { configLab.message(etat.alerte.type, etat.alerte.texte); etat.alerte = null; }
    if (!DEMO && !table('Personnes')) { app.innerHTML = vueInstallation(); return; }
    if (r.vue === 'personne') html = vuePersonne(r.id);
    else if (r.vue === 'formPersonne') html = vueFormPersonne(r.id, r.structure);
    else if (r.vue === 'structures') html = vueStructures();
    else if (r.vue === 'structure') html = vueStructure(r.id);
    else if (r.vue === 'formStructure') html = vueFormStructure(r.id, r.parent);
    else if (r.vue === 'doublons') html = vueDoublons();
    else if (r.vue === 'fusion') html = vueFusion(r.garde, r.absorbe);
    else if (r.vue === 'importer') html = vueImporter();
    else if (r.vue === 'moi') { html = vueMoi(); if (!moi.verifie) assurerCompte().then(rendre); }
    else html = vuePersonnes();
    app.innerHTML = html;
  }
  function rendreResultats() {
    var z = document.getElementById('an-resultats');
    if (!z) { rendre(); return; }
    z.innerHTML = route().vue === 'structures' ? resultatsStructures() : resultatsPersonnes();
  }

  // ---------------------------------------------------------------------------
  // Événements
  // ---------------------------------------------------------------------------

  function telecharger(nom, texte, type) {
    try {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([texte], { type: type }));
      a.download = nom; document.body.appendChild(a); a.click(); a.remove();
      return true;
    } catch (e) { return false; }
  }
  function exporter(pid) {
    var p = idx.Personnes[pid];
    var fiche0 = { nom: p.Nom, courriel: emailDe(p), structure: cheminStructure(p.Structure), archivee: archivee(p) };
    champsActifs().forEach(function (c) { fiche0[c.libelle] = valeurTexte(c, p[c.col]); });
    var json = { exporte_le: new Date().toISOString(), fiche: fiche0,
      cite_dans: apparitions(pid).map(function (r) { return { table: NOMS_TABLES[r.table] || r.table, colonne: r.col, ligne: libelleLigne(r.table, r.ligne) }; }),
      nom_ecrit_dans: mentionsTexte(p.Nom).map(function (r) { return { table: NOMS_TABLES[r.table] || r.table, colonne: r.col, ligne: libelleLigne(r.table, r.ligne) }; }) };
    var texte = JSON.stringify(json, null, 2);
    var ok = telecharger('donnees-' + slug(p.Nom || 'personne').toLowerCase() + '.json', texte, 'application/json');
    (navigator.clipboard ? navigator.clipboard.writeText(texte) : Promise.reject()).catch(function () {});
    etat.alerte = { type: 'info', texte: (ok ? 'Fichier téléchargé et données copiées' : 'Données copiées') + ' : fiche, lignes où la personne est citée et mentions de son nom. À transmettre à la personne qui demande l\'accès à ses données.' };
    rendre();
  }
  function supprimer(type, ids) {
    var actions = [], groupes = {};
    ids.forEach(function (id) {
      apparitions(id, type).forEach(function (r) {
        if (ids.indexOf(r.ligne.id) >= 0 && r.table === type) return;
        var k = r.table + '|' + r.col;
        var g = groupes[k] = groupes[k] || { table: r.table, col: r.col, lignes: {} };
        var actuel = g.lignes[r.ligne.id] !== undefined ? g.lignes[r.ligne.id] : (r.mode === 'Ref' ? num(r.ligne[r.col]) : ['L'].concat(liste(r.ligne[r.col]).map(num)));
        g.lignes[r.ligne.id] = r.mode === 'Ref' ? 0 : actuel.filter(function (x, i) { return i === 0 || x !== id; });
      });
    });
    Object.keys(groupes).forEach(function (k) {
      var g = groupes[k], lid = Object.keys(g.lignes).map(Number), o = {};
      o[g.col] = lid.map(function (l) { return g.lignes[l]; });
      actions.push(['BulkUpdateRecord', g.table, lid, o]);
    });
    actions.push(['BulkRemoveRecord', type, ids]);
    etat.confirmation = null;
    executer(actions, ids.length > 1 ? ids.length + ' fiches supprimées.' : 'Fiche supprimée.', function () { location.hash = type === 'Structures' ? '#/structures' : '#/'; },
      'Suppression impossible : il faut être propriétaire du document (ou gestionnaire, si la fiche n\'est citée que dans l\'annuaire).');
  }

  app.addEventListener('click', function (e) {
    var t = e.target.closest('button,a');
    if (!t) return;
    var a = t.getAttribute('data-action');
    if (t.hasAttribute('data-moi')) etat.depuisMoi = true;
    if (t.hasAttribute('data-installer')) { installer(t.getAttribute('data-installer') === 'exemple'); return; }
    if (a === 'mettre-a-jour') { mettreAJour(); return; }
    if (t.hasAttribute('data-page')) { etat.page = num(t.getAttribute('data-page')); rendreResultats(); document.getElementById('an-resultats').scrollIntoView(); return; }
    if (a === 'effacer-filtres') { etat.f = { q: '', structure: '', fonction: '', statut: 'actives', sansCourriel: false, gestion: false, perso: {} }; etat.page = 0; rendre(); return; }
    if (t.hasAttribute('data-annuler')) { delete etat.brouillons[t.getAttribute('data-annuler')]; return; }
    if (t.hasAttribute('data-archiver')) {
      var pid = num(t.getAttribute('data-archiver')), p = idx.Personnes[pid], o = archivee(p) ? { Archive: false } : { Archive: true };
      if (aCol('Personnes', 'Archive_le') || DEMO) o.Archive_le = archivee(p) ? null : aujourdhui();
      executer([['UpdateRecord', 'Personnes', pid, o]], archivee(p) ? 'Fiche réactivée.' : 'Fiche archivée : elle n\'apparaît plus dans les listes, son historique est gardé.');
      return;
    }
    if (t.hasAttribute('data-fusionner-avec')) { var f = num(t.getAttribute('data-fusionner-avec')); etat.fusionAvec = etat.fusionAvec === f ? null : f; rendre(); return; }
    if (t.hasAttribute('data-exporter')) { exporter(num(t.getAttribute('data-exporter'))); return; }
    if (t.hasAttribute('data-supprimer')) { var s = t.getAttribute('data-supprimer').split(':'); etat.confirmation = { type: s[0], ids: [num(s[1])] }; rendre(); return; }
    if (a === 'purger') { etat.confirmation = { type: 'Personnes', ids: filtrer().map(function (p) { return p.id; }) }; app.querySelector('#an-resultats').insertAdjacentHTML('afterbegin', texteConfirmation(etat.confirmation)); return; }
    if (a === 'confirmer-suppression' && etat.confirmation) { supprimer(etat.confirmation.type, etat.confirmation.ids); return; }
    if (a === 'annuler-suppression') { etat.confirmation = null; rendre(); return; }
    if (t.hasAttribute('data-pas-doublon')) {
      var cle = t.getAttribute('data-pas-doublon');
      var nv = JSON.parse(JSON.stringify(reglages)); nv.pasDoublons = (nv.pasDoublons || []).concat([cle]);
      if (DEMO) { appliquerReglages(nv); etat.alerte = { type: 'success', texte: 'Paire retirée des doublons.' }; rendre(); return; }
      grist.docApi.applyUserActions([['ModifyColumn', 'Personnes', NOM_COLONNE_CONFIG, { description: JSON.stringify(nv) }]]).then(function () {
        etat.alerte = { type: 'success', texte: 'Paire retirée des doublons.' }; return charger();
      }).then(rendre).catch(function (err) { etat.alerte = { type: 'error', texte: messageRefus(err, 'Seuls les propriétaires du document peuvent enregistrer ce choix.') }; rendre(); });
      return;
    }
    if (t.hasAttribute('data-fusionner')) {
      var ids = t.getAttribute('data-fusionner').split(':').map(num), pl = planFusion(ids[0], ids[1]);
      executer(pl.actions, 'Fiches fusionnées. « ' + pl.absorbe.Nom + ' » est archivée et renvoie vers cette fiche.', function () { location.hash = '#/personne/' + ids[0]; },
        'Fusion impossible : elle touche des tables que seuls les propriétaires du document peuvent modifier.');
      return;
    }
    if (t.hasAttribute('data-remplacer')) {
      var m = t.getAttribute('data-remplacer').split(':'), r0 = route(), anc = idx.Personnes[r0.id], cible = anc && idx.Personnes[num(anc.Fusionne_dans)];
      var ligne = (autres[m[0]] || []).filter(function (l) { return l.id === num(m[1]); })[0];
      if (!ligne || !cible) return;
      var o2 = {}; o2[m[2]] = remplacerNom(ligne[m[2]], anc.Nom, cible.Nom);
      executer([['UpdateRecord', m[0], ligne.id, o2]], 'Nom remplacé.');
      return;
    }
    if (a === 'lire-texte') { var z = document.getElementById('imp-texte'); demarrerImport(z.value, ''); return; }
    if (a === 'abandonner-import') { etat.imp = null; rendre(); return; }
    if (a === 'importer') { importer(); return; }
  });
  function demarrerImport(texte, nom) {
    var c = lireCsv(texte);
    etat.imp = { nom: nom, entetes: c.entetes, lignes: c.lignes, corr: deviner(c.entetes), creer: true, doublons: false };
    rendre();
  }

  app.addEventListener('input', function (e) {
    var t = e.target;
    if (t.matches('[data-filtre="q"]')) { etat.f.q = t.value; etat.page = 0; rendreResultats(); return; }
    if (t.matches('[data-filtre-structures]')) { etat.qs = t.value; rendreResultats(); return; }
    if (t.hasAttribute('data-brouillon') && t.type !== 'checkbox') {
      brouillon(t.getAttribute('data-brouillon'))[t.getAttribute('data-champ')] = t.value;
      if (t.id === 'pf-email') { var z = document.getElementById('pf-doublon'), f = t.closest('form'); if (z) z.innerHTML = avisDoublon(num(f.getAttribute('data-id')), t.value); }
    }
  });
  app.addEventListener('change', function (e) {
    var t = e.target;
    if (t.hasAttribute('data-filtre') && t.getAttribute('data-filtre') !== 'q') {
      var k = t.getAttribute('data-filtre'); etat.f[k] = t.type === 'checkbox' ? t.checked : t.value; etat.page = 0; etat.confirmation = null; rendreResultats(); return;
    }
    if (t.hasAttribute('data-filtre-perso')) { etat.f.perso[t.getAttribute('data-filtre-perso')] = t.value; etat.page = 0; rendreResultats(); return; }
    if (t.hasAttribute('data-tri')) { etat.tri = t.value; rendreResultats(); return; }
    if (t.hasAttribute('data-brouillon')) {
      var b = brouillon(t.getAttribute('data-brouillon')), c = t.getAttribute('data-champ');
      if (t.type === 'checkbox' && t.hasAttribute('data-option')) {
        var v = liste(b[c]).filter(function (x) { return x !== t.getAttribute('data-option'); });
        if (t.checked) v.push(t.getAttribute('data-option'));
        b[c] = ['L'].concat(v);
      } else b[c] = t.type === 'checkbox' ? t.checked : t.value;
      return;
    }
    if (t.id === 'imp-fichier' && t.files && t.files[0]) {
      var f = t.files[0], lecteur = new FileReader();
      lecteur.onload = function () { demarrerImport(lecteur.result, f.name); };
      lecteur.readAsText(f, 'utf-8');
      return;
    }
    if (t.hasAttribute('data-corr')) { etat.imp.corr[t.getAttribute('data-corr')] = t.value === '' ? undefined : num(t.value); rendre(); return; }
    if (t.hasAttribute('data-imp-option')) { etat.imp[t.getAttribute('data-imp-option')] = t.checked; rendre(); return; }
  });
  app.addEventListener('submit', function (e) {
    var f = e.target, type = f.getAttribute('data-form');
    if (!type) return;
    e.preventDefault();
    var id = num(f.getAttribute('data-id')), cle = f.getAttribute('data-cle'), b = brouillon(cle);
    if (type === 'personne') {
      if (!String(b.Nom || '').trim()) { etat.alerte = { type: 'error', texte: 'Le nom est obligatoire.' }; rendre(); return; }
      if (b.Email && !courrielValide(String(b.Email).trim())) { etat.alerte = { type: 'error', texte: 'Le courriel n\'est pas valide.' }; rendre(); return; }
      var o = champsPersonneDepuisBrouillon(b, id ? idx.Personnes[id] : null);
      if (id) executer([['UpdateRecord', 'Personnes', id, o]], 'Fiche enregistrée.', function () { delete etat.brouillons[cle]; location.hash = '#/personne/' + id; });
      else ecrire([['AddRecord', 'Personnes', null, o]]).then(function (res) {
        delete etat.brouillons[cle]; etat.alerte = { type: 'success', texte: 'Personne ajoutée.' }; etat.garderAlerte = true;
        return (DEMO ? Promise.resolve() : charger()).then(function () { location.hash = '#/personne/' + res.retValues[0]; });
      }).catch(function (err) { etat.alerte = { type: 'error', texte: messageRefus(err, 'Ajout impossible.') }; rendre(); });
      return;
    }
    if (type === 'structure') {
      if (!String(b.Nom || '').trim()) { etat.alerte = { type: 'error', texte: 'Le nom est obligatoire.' }; rendre(); return; }
      if (b.Site && !/^https:\/\//i.test(String(b.Site).trim())) { etat.alerte = { type: 'error', texte: 'Le site doit commencer par https://' }; rendre(); return; }
      var s = champsStructureDepuisBrouillon(b);
      if (id) executer([['UpdateRecord', 'Structures', id, s]], 'Structure enregistrée.', function () { delete etat.brouillons[cle]; location.hash = '#/structure/' + id; });
      else ecrire([['AddRecord', 'Structures', null, s]]).then(function (res) {
        delete etat.brouillons[cle]; etat.alerte = { type: 'success', texte: 'Structure ajoutée.' }; etat.garderAlerte = true;
        return (DEMO ? Promise.resolve() : charger()).then(function () { location.hash = '#/structure/' + res.retValues[0]; });
      }).catch(function (err) { etat.alerte = { type: 'error', texte: messageRefus(err, 'Ajout impossible : seuls les propriétaires et les gestionnaires de l\'annuaire créent des structures.') }; rendre(); });
      return;
    }
    if (type === 'fusion-avec') {
      var autre = num(document.getElementById('fa-autre').value);
      if (autre) { etat.fusionAvec = null; location.hash = '#/fusion/' + id + '/' + autre; }
    }
  });

  window.addEventListener('hashchange', function () {
    if (etat.garderAlerte) etat.garderAlerte = false; else etat.alerte = null;
    etat.confirmation = null; etat.fusionAvec = null;
    var r = route();
    if (configLab && configLab.ongletActif() !== 'apercu') configLab.onglet(r.vue === 'reglages' ? 'reglages' : 'vue');
    rendre(); window.scrollTo(0, 0);
  });
  app.addEventListener('focusout', function () {
    if (etat.rendreApresSaisie) { etat.rendreApresSaisie = false; setTimeout(rendre, 0); }
  });
  function rendreSiLibre() {
    var a = document.activeElement;
    if (a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) { etat.rendreApresSaisie = true; return; }
    rendre();
  }

  // ---------------------------------------------------------------------------
  // Thème
  // ---------------------------------------------------------------------------

  var choixTheme = 'auto';
  try { choixTheme = localStorage.getItem('an-theme') || 'auto'; } catch (e) { /* stockage indisponible */ }
  function themeGrist() {
    var st = getComputedStyle(document.documentElement);
    var m = (st.getPropertyValue('--grist-theme-page-bg') || st.getPropertyValue('--grist-theme-bg') || '').trim().match(/^#([0-9a-f]{6})$/i);
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.5 ? 'dark' : 'light';
  }
  function appliquerTheme() {
    var t = choixTheme;
    if (t === 'auto') t = themeGrist() || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-fr-theme', t);
  }
  var selectTheme = document.getElementById('an-theme');
  selectTheme.value = choixTheme;
  selectTheme.addEventListener('change', function () {
    choixTheme = selectTheme.value;
    try { localStorage.setItem('an-theme', choixTheme); } catch (e) { /* stockage indisponible */ }
    appliquerTheme();
  });
  new MutationObserver(appliquerTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---------------------------------------------------------------------------
  // Démarrage
  // ---------------------------------------------------------------------------

  appliquerTheme();
  function erreurChargement(err) {
    app.innerHTML = '<div class="fr-alert fr-alert--error"><h2 class="fr-alert__title">Chargement impossible</h2>' +
      '<p>Vérifiez que le widget a l\'accès « Accès complet au document ». Détail : ' + esc((err && err.message) || err) + '</p></div>';
  }
  document.getElementById('an-actualiser').addEventListener('click', function () { charger().then(rendre).catch(erreurChargement); });
  // Démonstration : accès aux données pour les tests.
  window.anEtat = function () { return { personnes: data.Personnes.length, structures: data.Structures.length, doublons: doublons().length, autres: autres, reglages: reglages }; };

  try {
    if (sessionStorage.getItem('an-regles')) { sessionStorage.removeItem('an-regles'); etat.alerte = { type: 'success', texte: 'Règles d\'accès installées. Vous pouvez les voir dans Grist : menu Règles d\'accès.' }; etat.garderAlerte = true; }
  } catch (e) { /* stockage indisponible */ }
  if (DEMO) {
    document.getElementById('an-demo').hidden = false;
    charger().then(rendre).catch(erreurChargement);
  } else {
    grist.ready({ requiredAccess: 'full', allowSelectBy: false });
    var attente = null;
    grist.onRecords(function () {
      clearTimeout(attente);
      attente = setTimeout(function () { charger().then(function () { appliquerTheme(); rendreSiLibre(); }).catch(erreurChargement); }, 150);
    });
    setInterval(function () { if (!document.hidden) charger().then(rendreSiLibre).catch(function () {}); }, 60000);
  }
})();
