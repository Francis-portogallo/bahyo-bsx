// src/routes/export.js
// @version 1.2.0
// @date    2026-09-22
// @change  1.2.0 — Le parcours de l'annotateur accompagne chaque annotation :
//                  ce qui a ete consulte avant de conclure fait partie de ce
//                  qui s'enseigne.
//          1.1.0 — specification_modes_exclusion.md §6 : inscription_finalite,
//                  modes_exclusion, potentiellement_performatif (derive a
//                  l'export, jamais stocke), champ_pratique.
//          1.0.0 — Export vers le SLM, conforme au schema de la Partie L.2 du
//                  cahier de recette du 18/09/2026.
//                  Monte sur /atelier/export (requireAnnotateur herite).
//
// Portees (L.1) :
//   GET /atelier/export/experience/:id          une experience
//   GET /atelier/export?categorie=&statut=...   un lot filtre
//   GET /atelier/export?tout=1                  l'integralite
//
// Options :
//   ?historique=0   exclut les versions anterieures d'annotation (defaut : 1)
//   ?fichier=1      force le telechargement en piece jointe
//
// Le JSON est indente (L.1) et UTF-8. Aucun champ n'est tronque.
// ============================================================================
import { Router } from 'express';
import { query }  from '../db/pool.js';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────
const iso = d => (d instanceof Date ? d.toISOString() : d || null);

async function versionManuelCourante() {
  const { rows } = await query(
    "SELECT valeur FROM bahyo_config WHERE cle = 'atelier_manuel_version'");
  return rows[0] ? parseInt(rows[0].valeur, 10) : 1;
}

/**
 * Construit le document d'export pour une liste d'ids d'experience.
 * Une seule serie de requetes pour tout le lot (pas de N+1).
 */
async function batir(expIds, { historique = true } = {}) {
  if (!expIds.length) return [];

  const [exps, noyaux, annots, hist, groupes, membres, exclusions, msgs,
         parcours, manques] =
    await Promise.all([
    query(`SELECT e.*, c.nom AS corpus_nom, c.version_decoupeur AS corpus_decoupeur
           FROM bahyo_atelier_experience e
           LEFT JOIN bahyo_atelier_corpus c ON c.id = e.corpus_id
           WHERE e.id = ANY($1) ORDER BY e.profil_ref`, [expIds]),

    query(`SELECT * FROM bahyo_atelier_noyau
           WHERE experience_id = ANY($1) ORDER BY experience_id, rang`, [expIds]),

    query(`SELECT a.*, u.email AS annotateur_email
           FROM bahyo_atelier_annotation a
           LEFT JOIN bahyo_user u ON u.id = a.annotateur_id
           WHERE a.noyau_id IN (SELECT id FROM bahyo_atelier_noyau WHERE experience_id = ANY($1))
           ORDER BY a.noyau_id, a.place`, [expIds]),

    historique
      ? query(`SELECT h.*, u.email AS annotateur_email
               FROM bahyo_atelier_annotation_historique h
               LEFT JOIN bahyo_user u ON u.id = h.annotateur_id
               WHERE h.noyau_id IN (SELECT id FROM bahyo_atelier_noyau WHERE experience_id = ANY($1))
               ORDER BY h.annotation_id, h.revision`, [expIds])
      : Promise.resolve({ rows: [] }),

    query(`SELECT g.*, u.email AS annotateur_email
           FROM bahyo_atelier_groupe g
           LEFT JOIN bahyo_user u ON u.id = g.annotateur_id
           WHERE g.experience_id = ANY($1) ORDER BY g.created_at`, [expIds]),

    query(`SELECT gn.groupe_id, gn.noyau_id
           FROM bahyo_atelier_groupe_noyau gn
           JOIN bahyo_atelier_groupe g ON g.id = gn.groupe_id
           WHERE g.experience_id = ANY($1)`, [expIds]),

    query(`SELECT m.*, u.email AS annotateur_email
           FROM bahyo_atelier_mode_exclusion m
           LEFT JOIN bahyo_user u ON u.id = m.annotateur_id
           JOIN bahyo_atelier_groupe g ON g.id = m.groupe_id
           WHERE g.experience_id = ANY($1)
           ORDER BY m.created_at`, [expIds]),

    query(`SELECT m.* FROM bahyo_atelier_message m
           WHERE m.experience_id = ANY($1)
              OR m.noyau_id IN (SELECT id FROM bahyo_atelier_noyau WHERE experience_id = ANY($1))
           ORDER BY COALESCE(m.noyau_id, m.experience_id), m.place, m.created_at, m.tour`,
          [expIds]),

    query(`SELECT p.* FROM bahyo_atelier_parcours p
           WHERE p.noyau_id IN (SELECT id FROM bahyo_atelier_noyau
                                WHERE experience_id = ANY($1))`, [expIds]),

    query(`SELECT mq.*, u.email AS annotateur_email
           FROM bahyo_atelier_manque mq
           LEFT JOIN bahyo_user u ON u.id = mq.annotateur_id
           WHERE mq.experience_id = ANY($1)
              OR mq.noyau_id IN (SELECT id FROM bahyo_atelier_noyau WHERE experience_id = ANY($1))
           ORDER BY mq.created_at`, [expIds]),
  ]);

  // ── Index ──────────────────────────────────────────────────────────────────
  const noyauxParExp = new Map();
  const expParNoyau  = new Map();
  for (const n of noyaux.rows) {
    if (!noyauxParExp.has(n.experience_id)) noyauxParExp.set(n.experience_id, []);
    noyauxParExp.get(n.experience_id).push(n);
    expParNoyau.set(n.id, n.experience_id);
  }

  const annotsParNoyau = new Map();
  for (const a of annots.rows) {
    if (!annotsParNoyau.has(a.noyau_id)) annotsParNoyau.set(a.noyau_id, []);
    annotsParNoyau.get(a.noyau_id).push(a);
  }

  const histParAnnot = new Map();
  for (const h of hist.rows) {
    if (!histParAnnot.has(h.annotation_id)) histParAnnot.set(h.annotation_id, []);
    histParAnnot.get(h.annotation_id).push(h);
  }

  const membresParGroupe = new Map();
  for (const m of membres.rows) {
    if (!membresParGroupe.has(m.groupe_id)) membresParGroupe.set(m.groupe_id, []);
    membresParGroupe.get(m.groupe_id).push(m.noyau_id);
  }

  const exclusionsParGroupe = new Map();
  for (const m of exclusions.rows) {
    if (!exclusionsParGroupe.has(m.groupe_id)) exclusionsParGroupe.set(m.groupe_id, []);
    exclusionsParGroupe.get(m.groupe_id).push(m);
  }

  const parcoursParNoyau = new Map();
  for (const p of parcours.rows) parcoursParNoyau.set(p.noyau_id, p);

  const groupesParExp = new Map();
  for (const g of groupes.rows) {
    if (!groupesParExp.has(g.experience_id)) groupesParExp.set(g.experience_id, []);
    groupesParExp.get(g.experience_id).push(g);
  }

  const manquesParExp = new Map();
  for (const m of manques.rows) {
    const eid = m.experience_id || expParNoyau.get(m.noyau_id);
    if (!eid) continue;
    if (!manquesParExp.has(eid)) manquesParExp.set(eid, []);
    manquesParExp.get(eid).push(m);
  }

  // Les messages sont regroupes en DIALOGUES par (contexte, place) — B.5
  const dialoguesParExp = new Map();
  const fils = new Map();
  for (const m of msgs.rows) {
    const eid = m.experience_id || expParNoyau.get(m.noyau_id);
    if (!eid) continue;
    const ctxType = m.noyau_id ? 'noyau' : m.groupe_id ? 'groupe' : 'experience';
    const ctxId   = m.noyau_id || m.groupe_id || m.experience_id;
    const cle     = `${eid}||${ctxType}||${ctxId}||${m.place || 'global'}`;
    if (!fils.has(cle)) fils.set(cle, { eid, ctxType, ctxId, place: m.place || 'global', tours: [] });
    fils.get(cle).tours.push(m);
  }
  for (const f of fils.values()) {
    if (!dialoguesParExp.has(f.eid)) dialoguesParExp.set(f.eid, []);
    dialoguesParExp.get(f.eid).push(f);
  }

  // ── Assemblage ─────────────────────────────────────────────────────────────
  return exps.rows.map(e => {
    const mesNoyaux = noyauxParExp.get(e.id) || [];

    const noyauxExp = mesNoyaux.map(n => {
      const mesAnnots = (annotsParNoyau.get(n.id) || []).map(a => {
        const out = {
          id_annotation: a.id,
          place: a.place,
          regime: a.regime,
          identification: a.identification,
          sous_type: a.sous_categorie,
          candidat_composition: a.a_composer,
          champs_specifiques: a.champs_specifiques,
          commentaire: a.commentaire,
          statut: a.statut,
          revision: a.revision,
          proposition_assistant: a.proposition_assistant,
          ecart_assistant: a.ecart_assistant,
          ecart_explication: a.ecart_explication,
          annotateur: a.annotateur_email || a.annotateur_id,
          horodatage: iso(a.updated_at),
          cree_le: iso(a.created_at),
          version_manuel: a.version_manuel,
        };
        if (historique) {
          out.historique = (histParAnnot.get(a.id) || []).map(h => ({
            revision: h.revision,
            regime: h.regime,
            identification: h.identification,
            sous_type: h.sous_categorie,
            candidat_composition: h.a_composer,
            commentaire: h.commentaire,
            statut: h.statut,
            ecart_assistant: h.ecart_assistant,
            ecart_explication: h.ecart_explication,
            version_manuel: h.version_manuel,
            annotateur: h.annotateur_email || h.annotateur_id,
            valide_de: iso(h.valide_de),
            valide_a: iso(h.valide_a),
          }));
        }
        return out;
      });

      return {
        id_noyau: n.id,
        texte: n.texte,
        origine: n.origine,
        forme: n.forme,
        marquages_decoupeur: {
          verbe_faible: n.verbe_faible,
          objet_faible: n.objet_faible,
          composition:  n.composition,
          objet_prep:   n.objet_prep,
        },
        version_decoupeur: n.version_decoupeur || e.corpus_decoupeur,
        rang_dans_description: n.rang,
        force_horn: n.force_horn,
        sans_tiers_assistant: n.sans_tiers_assistant,
        statut_orphelin: n.statut_orphelin,
        // Ce qui a ete fait avant de conclure. Seuls des actes verifiables
        // y figurent : la lecture du texte source n'est pas observable et
        // n'est donc pas inventee.
        parcours: (() => {
          const p = parcoursParNoyau.get(n.id);
          if (!p) return null;
          return {
            ouvert_a: iso(p.ouvert_a),
            conclu_a: iso(p.conclu_a),
            duree_s: p.duree_s == null ? null : Math.round(+p.duree_s),
            cas_similaires_consultes: +p.n_similaires,
            sections_formalisme_lues: p.sections_lues || [],
            propositions_demandees: +p.n_propositions,
            tours_de_dialogue: +p.n_tours,
            manques_signales: +p.n_manques,
            ordre_des_places: p.ordre_places || [],
          };
        })(),
        annotations: mesAnnots,
      };
    });

    const groupesExp = (groupesParExp.get(e.id) || []).map(g => {
      const mx = exclusionsParGroupe.get(g.id) || [];
      return {
        id_groupe: g.id,
        tiers: g.tiers,
        tiers_source: g.tiers_source,
        noyaux_membres: membresParGroupe.get(g.id) || [],
        finalite_exprimee: g.finalite_exprimee,
        inscription_finalite: g.inscription_finalite,
        modes_exclusion: mx.map(m => ({
          mode: m.mode,
          libelle_propose: m.libelle_propose,
          justification: m.justification,
          annotateur: m.pose_par === 'systeme'
            ? 'systeme'
            : (m.annotateur_email || m.annotateur_id),
          pose_par: m.pose_par,
          horodatage: iso(m.created_at),
          version_manuel: m.version_manuel,
        })),
        // DERIVE (4.5) : negation par l'echec. Exporte bien que calculable,
        // pour permettre une verification de coherence a la reprise (§6).
        potentiellement_performatif: mx.length === 0,
        champ_pratique: g.champ_pratique,
        nom_bs_composite: g.libelle,
        justification: g.justification,
        origine: g.origine,
        statut: g.statut,
        revision: g.revision,
        proposition_assistant: g.proposition_assistant,
        annotateur: g.annotateur_email || g.annotateur_id,
        horodatage: iso(g.updated_at),
        version_manuel: g.version_manuel,
      };
    });

    const dialoguesExp = (dialoguesParExp.get(e.id) || []).map(f => {
      const dern = f.tours[f.tours.length - 1];
      return {
        id_dialogue: `${f.ctxType}:${f.ctxId}:${f.place}`,
        contexte: { type: f.ctxType, id: f.ctxId },
        place: f.place,
        type_dialogue: dern?.type_dialogue || 'avec_annotateur',
        tours: f.tours.map((t, i) => ({
          tour: t.tour ?? i + 1,
          role: t.role,
          contenu: t.contenu,
          horodatage: iso(t.created_at),
          modele: t.modele,
          registre: t.registre,
          documents_consultes: t.documents_consultes || [],
        })),
        resultat: f.tours.map(t => t.resultat_annotation_id).filter(Boolean).pop() || null,
        documents_consultes: [...new Set(
          f.tours.flatMap(t => t.documents_consultes || [])
        )],
        version_manuel: dern?.version_manuel ?? null,
      };
    });

    const manquesExp = (manquesParExp.get(e.id) || []).map(m => ({
      id_manque: m.id,
      contexte: m.noyau_id ? { type: 'noyau', id: m.noyau_id }
              : m.groupe_id ? { type: 'groupe', id: m.groupe_id }
              : { type: 'experience', id: e.id },
      place: m.place,
      type: m.type_manque,
      description: m.description,
      question_type: m.question_type,
      criticite: m.criticite,
      detecte_par: m.detecte_par,
      statut: m.statut,
      resolution: m.resolution,
      manuel_section_ref: m.manuel_section_ref,
      manuel_version_ref: m.manuel_version_ref,
      annotateur: m.annotateur_email || m.annotateur_id,
      horodatage: iso(m.created_at),
      resolu_at: iso(m.resolu_at),
    }));

    return {
      id_experience: e.id,
      profil: e.profil_ref,
      poste: e.poste,
      secteur: e.secteur,
      categorie: e.categorie,
      texte_source: e.texte_source,
      semes_detectes: e.semes_detectes,
      corpus: e.corpus_nom,
      exploitable: e.exploitable,
      motif_non_exploitable: e.motif_non_exploitable,
      date_import: iso(e.created_at),
      statut: e.statut,
      noyaux: noyauxExp,
      groupes_a3: groupesExp,
      dialogues: dialoguesExp,
      manques: manquesExp,
    };
  });
}

/**
 * Controle de coherence referentielle — L.5.
 * Retourne la liste des anomalies (vide si tout est coherent).
 */
function verifier(experiences) {
  const pbs = [];
  for (const e of experiences) {
    const ids = new Set(e.noyaux.map(n => n.id_noyau));

    for (const g of e.groupes_a3) {
      for (const nid of g.noyaux_membres) {
        if (!ids.has(nid)) {
          pbs.push(`groupe ${g.id_groupe} : noyau ${nid} absent de l'experience ${e.id_experience}`);
        }
      }
      // Plafond latent (P.3), porte desormais sur inscription_finalite
      if (g.tiers_source === 'implicite' && g.inscription_finalite === 'porte') {
        pbs.push(`groupe ${g.id_groupe} : tiers implicite annote « porte » `
               + `(plafond « latent »)`);
      }
      // Coherence 4.6 : atomise implique sans_chaine_finalite
      const modes = (g.modes_exclusion || []).map(m => m.mode);
      if (g.inscription_finalite === 'atomise' && !modes.includes('sans_chaine_finalite')) {
        pbs.push(`groupe ${g.id_groupe} : inscription « atomise » sans le mode `
               + `« sans_chaine_finalite »`);
      }
      // Derivation (4.5)
      const attendu = modes.length === 0;
      if (g.potentiellement_performatif !== attendu) {
        pbs.push(`groupe ${g.id_groupe} : potentiellement_performatif=`
               + `${g.potentiellement_performatif} incoherent avec `
               + `${modes.length} mode(s) d'exclusion`);
      }
      for (const m of (g.modes_exclusion || [])) {
        if (!m.justification?.trim()) {
          pbs.push(`groupe ${g.id_groupe} : mode « ${m.mode} » sans justification`);
        }
        if (m.mode === 'autre' && !m.libelle_propose?.trim()) {
          pbs.push(`groupe ${g.id_groupe} : mode « autre » sans libelle propose`);
        }
      }
    }
    for (const d of e.dialogues) {
      if (d.contexte.type === 'noyau' && !ids.has(d.contexte.id)) {
        pbs.push(`dialogue ${d.id_dialogue} : noyau ${d.contexte.id} introuvable`);
      }
    }
    for (const m of e.manques) {
      if (m.contexte.type === 'noyau' && !ids.has(m.contexte.id)) {
        pbs.push(`manque ${m.id_manque} : noyau ${m.contexte.id} introuvable`);
      }
    }
    for (const n of e.noyaux) {
      for (const a of n.annotations) {
        if (!a.place || !['A1', 'A2', 'A3'].includes(a.place)) {
          pbs.push(`annotation ${a.id_annotation} : place invalide (${a.place})`);
        }
      }
    }
    if (e.exploitable && !e.texte_source?.trim()) {
      pbs.push(`experience ${e.id_experience} : marquee exploitable mais texte source vide`);
    }
  }
  return pbs;
}

function compter(experiences) {
  const c = {
    experiences: experiences.length,
    noyaux: 0, annotations: 0, revisions_archivees: 0,
    par_place: { A1: 0, A2: 0, A3: 0 },
    par_regime: {}, par_inscription: {}, par_mode_exclusion: {},
    groupes: 0, groupes_potentiellement_performatifs: 0,
    noyaux_avec_parcours: 0,
    dialogues: 0, tours: 0, manques: 0,
    annotations_avec_ecart: 0, manques_avec_question: 0,
  };
  for (const e of experiences) {
    c.noyaux += e.noyaux.length;
    for (const n of e.noyaux) {
      if (n.parcours) c.noyaux_avec_parcours++;
      for (const a of n.annotations) {
        c.annotations++;
        if (c.par_place[a.place] !== undefined) c.par_place[a.place]++;
        if (a.regime) c.par_regime[a.regime] = (c.par_regime[a.regime] || 0) + 1;
        if (a.ecart_assistant) c.annotations_avec_ecart++;
        c.revisions_archivees += (a.historique || []).length;
      }
    }
    c.groupes += e.groupes_a3.length;
    for (const g of e.groupes_a3) {
      const p = g.inscription_finalite || 'non_qualifie';
      c.par_inscription[p] = (c.par_inscription[p] || 0) + 1;
      if (g.potentiellement_performatif) c.groupes_potentiellement_performatifs++;
      for (const m of (g.modes_exclusion || [])) {
        c.par_mode_exclusion[m.mode] = (c.par_mode_exclusion[m.mode] || 0) + 1;
      }
    }
    c.dialogues += e.dialogues.length;
    for (const d of e.dialogues) c.tours += d.tours.length;
    c.manques += e.manques.length;
    for (const m of e.manques) if (m.question_type) c.manques_avec_question++;
  }
  return c;
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════

// GET /atelier/export/experience/:id
router.get('/experience/:id', async (req, res) => {
  try {
    const historique = req.query.historique !== '0';
    const experiences = await batir([req.params.id], { historique });
    if (!experiences.length) return res.status(404).json({ error: 'Experience introuvable' });

    const doc = {
      meta: {
        genere_le: new Date().toISOString(),
        genere_par: req.user.id,
        portee: 'experience',
        version_schema: 'L.2/2026-09-22+parcours',
        version_manuel_courante: await versionManuelCourante(),
        historique_inclus: historique,
      },
      comptages: compter(experiences),
      anomalies: verifier(experiences),
      experiences,
    };
    envoyer(res, doc, req, `bahyo-atelier-${experiences[0].profil}.json`);
  } catch (err) {
    console.error('[EXPORT] Erreur experience:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /atelier/export?categorie=&statut=&corpus_id=&tout=1&annotees=1
router.get('/', async (req, res) => {
  try {
    const { categorie, statut, corpus_id } = req.query;
    const historique = req.query.historique !== '0';
    const tout       = req.query.tout === '1';
    const annotees   = req.query.annotees === '1';

    const where = [];
    const params = [];
    if (corpus_id) { params.push(corpus_id); where.push(`e.corpus_id = $${params.length}`); }
    if (categorie) { params.push(categorie); where.push(`e.categorie = $${params.length}`); }
    if (statut)    { params.push(statut);    where.push(`e.statut = $${params.length}`); }
    if (!tout)     { where.push('e.exploitable = TRUE'); }
    if (annotees)  {
      where.push(`EXISTS (SELECT 1 FROM bahyo_atelier_annotation a
                          JOIN bahyo_atelier_noyau n ON n.id = a.noyau_id
                          WHERE n.experience_id = e.id AND a.statut = 'valide')`);
    }

    const { rows } = await query(
      `SELECT e.id FROM bahyo_atelier_experience e
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY e.profil_ref`, params);

    const experiences = await batir(rows.map(r => r.id), { historique });

    const doc = {
      meta: {
        genere_le: new Date().toISOString(),
        genere_par: req.user.id,
        portee: tout ? 'integralite' : 'lot_filtre',
        filtres: { categorie: categorie || null, statut: statut || null,
                   corpus_id: corpus_id || null, annotees_seulement: annotees },
        version_schema: 'L.2/2026-09-22+parcours',
        version_manuel_courante: await versionManuelCourante(),
        historique_inclus: historique,
      },
      comptages: compter(experiences),
      anomalies: verifier(experiences),
      experiences,
    };
    envoyer(res, doc, req, `bahyo-atelier-${new Date().toISOString().slice(0, 10)}.json`);
  } catch (err) {
    console.error('[EXPORT] Erreur lot:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /atelier/export/controle — comptages et anomalies SANS le corps (L.5/L.6)
router.get('/controle', async (req, res) => {
  try {
    const { rows } = await query('SELECT id FROM bahyo_atelier_experience ORDER BY profil_ref');
    const experiences = await batir(rows.map(r => r.id), { historique: true });
    const anomalies = verifier(experiences);
    res.json({
      genere_le: new Date().toISOString(),
      version_manuel_courante: await versionManuelCourante(),
      comptages: compter(experiences),
      anomalies,
      coherence_referentielle: anomalies.length === 0 ? 'OK' : `${anomalies.length} anomalie(s)`,
    });
  } catch (err) {
    console.error('[EXPORT] Erreur controle:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /atelier/export/manuel — la doctrine et tout son historique (B.7 / M.2)
router.get('/manuel', async (req, res) => {
  try {
    const [cour, vers] = await Promise.all([
      query('SELECT * FROM bahyo_atelier_manuel ORDER BY ordre'),
      query(`SELECT v.*, u.email AS auteur_email
             FROM bahyo_atelier_manuel_version v
             LEFT JOIN bahyo_user u ON u.id = v.auteur_id
             ORDER BY v.section_cle, v.version`),
    ]);
    res.json({
      genere_le: new Date().toISOString(),
      version_globale: await versionManuelCourante(),
      sections: cour.rows.map(s => ({
        section_cle: s.section_cle, titre: s.titre, contenu_md: s.contenu_md,
        ordre: s.ordre, version: s.version,
        dernier_quoi: s.dernier_quoi, dernier_ou: s.dernier_ou,
        dernier_pourquoi: s.dernier_pourquoi,
        horodatage: iso(s.updated_at),
        historique: vers.rows.filter(v => v.section_cle === s.section_cle).map(v => ({
          version: v.version, version_globale: v.version_globale,
          titre: v.titre, contenu_md: v.contenu_md,
          quoi: v.quoi, ou: v.ou, pourquoi: v.pourquoi,
          auteur: v.auteur_email || v.auteur_id,
          valide_de: iso(v.valide_de), valide_a: iso(v.valide_a),
        })),
      })),
    });
  } catch (err) {
    console.error('[EXPORT] Erreur manuel:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── Emission ─────────────────────────────────────────────────────────────────
function envoyer(res, doc, req, nom) {
  const json = JSON.stringify(doc, null, 2);   // indente pour lisibilite humaine (L.1)
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.query.fichier === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${nom}"`);
  }
  res.send(json);
}

export default router;
