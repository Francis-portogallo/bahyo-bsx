// src/routes/atelier.js
// @version 1.2.0
// @date    2026-09-22
// @change  1.2.0 — specification_modes_exclusion.md v1.0 :
//                  potentiel_performatif -> inscription_finalite (renommage),
//                  modes d'exclusion (table dediee), potentiellement_performatif
//                  DERIVE et jamais saisi, champ_pratique, registre des modes.
//                  Terminologie : le terme « doctrine » est proscrit.
//                  FORMALISME 3A designe le systeme, qui est stable ;
//                  REGLES D'APPLICATION designe ce qui evolue et se versionne.
//          1.1.0 — Mise en conformite cahier de recette (18/09/2026) :
//                  estampillage version_manuel, statut d'experience,
//                  statut/resolution des manques, versionnement du manuel,
//                  noyaux sans tiers + statut orphelin, contexte assistant
//                  enrichi, montage du sous-routeur /export.
//          1.0.0 — Atelier d'annotation BS. Routes protegees par requireAnnotateur.
//                  Corpus / experiences / noyaux / annotations / manques /
//                  groupes A3 / dialogue assistant / manuel vivant / stats.
//                  Assistant : Mistral via src/services/mistral.js (remplacable
//                  par le SLM entraine sans toucher aux routes).
// ============================================================================
import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import * as mistral from '../services/mistral.js';
import exportRoutes from './export.js';

const router = Router();

// ── Vocabulaire normalise (aligne prompt A3 v0.2 + cahier de conception) ─────
const REGIMES = ['declaratif', 'constatif', 'orphelin'];
const SOUS_CATEGORIES = ['fonctionnel', 'relationnel'];
const INSCRIPTIONS = ['porte', 'latent', 'atomise'];   // ex-potentiel_performatif
const PLACES = ['A1', 'A2', 'A3'];
const STATUTS_ANNOTATION = ['brouillon', 'valide', 'litigieux', 'a_revoir'];
const STATUTS_EXPERIENCE = ['nouveau', 'en_cours', 'annote', 'a_revoir'];
const STATUTS_MANQUE     = ['ouvert', 'en_discussion', 'resolu'];
const STATUTS_GROUPE     = ['proposition', 'valide', 'rejete', 'orphelin'];
const STATUTS_ORPHELIN   = ['candidat', 'confirme', 'rattache'];
const TYPES_DIALOGUE     = ['interne_assistant', 'avec_annotateur', 'avec_utilisateur'];
const POSE_PAR           = ['annotateur', 'systeme', 'assistant'];
const TYPES_MANQUE = [
  { code: 'contexte_projet',     label: 'Contexte du projet absent' },
  { code: 'precision_acte',      label: "Acte insuffisamment precis" },
  { code: 'perimetre',           label: 'Perimetre non delimite' },
  { code: 'resultat_mesurable',  label: 'Resultat non mesurable' },
  { code: 'tiers_absent',        label: 'Aucun tiers attestataire' },
  { code: 'tiers_implicite',     label: 'Tiers present mais non nomme' },
  { code: 'finalite_absente',    label: 'Finalite non exprimee' },
  { code: 'datation',            label: 'Periode non datee' },
  { code: 'procede_non_nomme',   label: 'Procede employe non nomme' },
  { code: 'echelle',             label: "Echelle de l'intervention inconnue" },
  { code: 'champ_manquant',      label: 'Champ manquant dans le schema' },
  { code: 'incoherence_formalisme', label: 'Incoherence avec le formalisme' },
  { code: 'cas_non_couvert',     label: 'Cas non couvert par le manuel' },
  { code: 'autre',               label: 'Autre' },
];

// Version courante des regles d'application — estampillee sur toute decision.
// Le FORMALISME 3A (trois places, agglomeration par A3) est stable ; ce qui
// evolue et se versionne, ce sont ses regles d'application.
async function versionManuel() {
  const { rows } = await query(
    "SELECT valeur FROM bahyo_config WHERE cle = 'atelier_manuel_version'");
  return rows[0] ? parseInt(rows[0].valeur, 10) : 1;
}

// Charge le registre des modes d'exclusion reconnus (4.4 : extensible sans
// migration — un mode promu est simplement ajoute a la table registre).
async function registreModes() {
  const { rows } = await query(
    `SELECT mode, libelle, definition FROM bahyo_atelier_mode_registre
     WHERE actif = TRUE ORDER BY ordre, mode`);
  return rows;
}

// Derivation (4.5) : negation par l'echec, jamais stockee.
//   non_valorisable             :- <un mode d'exclusion quelconque>.
//   potentiellement_performatif :- not non_valorisable.
async function exclusionsDeGroupes(groupeIds) {
  if (!groupeIds.length) return new Map();
  const { rows } = await query(
    `SELECT m.*, u.email AS annotateur_email
     FROM bahyo_atelier_mode_exclusion m
     LEFT JOIN bahyo_user u ON u.id = m.annotateur_id
     WHERE m.groupe_id = ANY($1) ORDER BY m.created_at`, [groupeIds]);
  const parGroupe = new Map();
  for (const m of rows) {
    if (!parGroupe.has(m.groupe_id)) parGroupe.set(m.groupe_id, []);
    parGroupe.get(m.groupe_id).push(m);
  }
  return parGroupe;
}

// Enrichit une liste de groupes avec leurs exclusions et le statut derive.
async function deriverGroupes(groupes) {
  const parGroupe = await exclusionsDeGroupes(groupes.map(g => g.id));
  return groupes.map(g => {
    const mx = parGroupe.get(g.id) || [];
    return {
      ...g,
      modes_exclusion: mx.map(m => ({
        id: m.id, mode: m.mode, libelle_propose: m.libelle_propose,
        justification: m.justification, pose_par: m.pose_par,
        annotateur: m.annotateur_email || m.annotateur_id,
        horodatage: m.created_at, version_manuel: m.version_manuel,
      })),
      // DERIVE — non saisissable, non stocke
      potentiellement_performatif: mx.length === 0,
      // Signale l'incoherence de 4.6 sans bloquer
      incoherence_atomise: g.inscription_finalite === 'atomise'
        && !mx.some(m => m.mode === 'sans_chaine_finalite'),
    };
  });
}

// Recalcule le statut d'une experience depuis l'etat reel de ses annotations.
// N'ecrase jamais un 'a_revoir' pose a la main (M.3).
async function majStatutExperience(expId) {
  const { rows } = await query(`
    SELECT e.statut,
           COUNT(DISTINCT n.id) AS noyaux,
           COUNT(a.id) FILTER (WHERE a.statut = 'valide') AS validees
    FROM bahyo_atelier_experience e
    LEFT JOIN bahyo_atelier_noyau n ON n.experience_id = e.id
    LEFT JOIN bahyo_atelier_annotation a ON a.noyau_id = n.id
    WHERE e.id = $1 GROUP BY e.statut`, [expId]);
  if (!rows[0] || rows[0].statut === 'a_revoir') return;
  const { noyaux, validees } = rows[0];
  const nouveau = +validees === 0 ? 'nouveau'
                : +validees >= +noyaux * 3 ? 'annote'
                : 'en_cours';
  if (nouveau !== rows[0].statut) {
    await query('UPDATE bahyo_atelier_experience SET statut = $2 WHERE id = $1',
                [expId, nouveau]);
  }
}

// ── Middleware requireAnnotateur ─────────────────────────────────────────────
async function requireAnnotateur(req, res, next) {
  try {
    const { rows } = await query(
      'SELECT is_annotateur, is_superadmin FROM bahyo_user WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0]?.is_annotateur && !rows[0]?.is_superadmin) {
      return res.status(403).json({ error: "Acces reserve aux annotateurs de l'atelier" });
    }
    req.isSuperadmin = !!rows[0].is_superadmin;
    next();
  } catch (err) {
    console.error('[ATELIER] Erreur annotateur check:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

router.use(requireAuth, requireAnnotateur);

// ── Contournement O2switch ───────────────────────────────────────────────────
// Apache/mod_security coupe les requetes PATCH avant qu'elles atteignent Node
// (ECONNRESET cote client). PUT et DELETE passent normalement. On enregistre
// donc chaque modification partielle sur les deux methodes : PUT fonctionne
// aujourd'hui, PATCH redeviendra utilisable sur un hebergement sans ce filtre.
function modifier(chemin, handler) {
  router.patch(chemin, handler);
  router.put(chemin, handler);
}

// ═══════════════════════════════════════════════════════════════════════════
//  REFERENTIEL
// ═══════════════════════════════════════════════════════════════════════════

router.get('/referentiel', async (req, res) => {
  res.json({
    regimes: REGIMES,
    sous_categories: SOUS_CATEGORIES,
    inscriptions_finalite: INSCRIPTIONS,
    places: PLACES,
    statuts_annotation: STATUTS_ANNOTATION,
    statuts_experience: STATUTS_EXPERIENCE,
    statuts_manque: STATUTS_MANQUE,
    statuts_groupe: STATUTS_GROUPE,
    statuts_orphelin: STATUTS_ORPHELIN,
    types_dialogue: TYPES_DIALOGUE,
    types_manque: TYPES_MANQUE,
    pose_par: POSE_PAR,
    modes_exclusion: await registreModes(),
    prompt_a3_version: mistral.PROMPT_A3_VERSION,
    version_manuel: await versionManuel(),
  });
});

// Sous-routeur d'export (Partie L du cahier de recette)
router.use('/export', exportRoutes);

// ═══════════════════════════════════════════════════════════════════════════
//  CORPUS
// ═══════════════════════════════════════════════════════════════════════════

router.get('/corpus', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT c.id, c.nom, c.source, c.description, c.version_decoupeur, c.created_at,
             COUNT(DISTINCT e.id) AS nb_experiences,
             COUNT(n.id)          AS nb_noyaux
      FROM bahyo_atelier_corpus c
      LEFT JOIN bahyo_atelier_experience e ON e.corpus_id = c.id
      LEFT JOIN bahyo_atelier_noyau      n ON n.experience_id = e.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json({ corpus: rows });
  } catch (err) {
    console.error('[ATELIER] Erreur corpus list:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  EXPERIENCES
// ═══════════════════════════════════════════════════════════════════════════

// GET /atelier/experiences?corpus_id=&categorie=&statut=&limit=&offset=
// statut : 'tous' | 'vierge' | 'en_cours' | 'complet'
router.get('/experiences', async (req, res) => {
  try {
    const { corpus_id, categorie, statut = 'tous', exploitable, pp } = req.query;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const where = [];
    const params = [];
    if (corpus_id) { params.push(corpus_id); where.push(`e.corpus_id = $${params.length}`); }
    if (categorie) { params.push(categorie); where.push(`e.categorie = $${params.length}`); }
    if (STATUTS_EXPERIENCE.includes(statut)) {
      params.push(statut); where.push(`e.statut = $${params.length}`);
    }
    if (exploitable === '1') where.push('e.exploitable = TRUE');
    if (exploitable === '0') where.push('e.exploitable = FALSE');
    // Filtre « potentiellement performatif » (5.3) : au moins un groupe sans
    // aucun mode d'exclusion / aucun groupe qui en soit exempt.
    if (pp === '1') where.push(`EXISTS (
      SELECT 1 FROM bahyo_atelier_groupe g2 WHERE g2.experience_id = e.id
        AND NOT EXISTS (SELECT 1 FROM bahyo_atelier_mode_exclusion x
                        WHERE x.groupe_id = g2.id))`);
    if (pp === '0') where.push(`NOT EXISTS (
      SELECT 1 FROM bahyo_atelier_groupe g2 WHERE g2.experience_id = e.id
        AND NOT EXISTS (SELECT 1 FROM bahyo_atelier_mode_exclusion x
                        WHERE x.groupe_id = g2.id))`);

    const having = '';
    params.push(limit, offset);

    const { rows } = await query(`
      SELECT e.id, e.profil_ref, e.poste, e.secteur, e.categorie,
             e.statut, e.exploitable, e.motif_non_exploitable,
             LEFT(e.texte_source, 240) AS extrait,
             e.semes_detectes,
             COUNT(DISTINCT n.id) AS nb_noyaux,
             COUNT(a.id)          AS nb_annotations,
             COUNT(DISTINCT g.id) AS nb_groupes,
             COUNT(DISTINCT g.id) FILTER (
               WHERE NOT EXISTS (SELECT 1 FROM bahyo_atelier_mode_exclusion x
                                 WHERE x.groupe_id = g.id)
             ) AS nb_pp
      FROM bahyo_atelier_experience e
      LEFT JOIN bahyo_atelier_noyau      n ON n.experience_id = e.id
      LEFT JOIN bahyo_atelier_annotation a ON a.noyau_id = n.id
      LEFT JOIN bahyo_atelier_groupe     g ON g.experience_id = e.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      GROUP BY e.id
      ${having}
      ORDER BY e.created_at, e.profil_ref
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ experiences: rows, limit, offset, statuts: STATUTS_EXPERIENCE });
  } catch (err) {
    console.error('[ATELIER] Erreur experiences list:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /atelier/experiences/:id  — detail complet
router.get('/experiences/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows: exp } = await query(
      'SELECT * FROM bahyo_atelier_experience WHERE id = $1', [id]
    );
    if (!exp[0]) return res.status(404).json({ error: 'Experience introuvable' });

    const { rows: noyaux } = await query(`
      SELECT n.*,
             COALESCE(json_agg(
               json_build_object(
                 'id', a.id, 'place', a.place, 'regime', a.regime,
                 'sous_categorie', a.sous_categorie,
                 'identification', a.identification,
                 'a_composer', a.a_composer,
                 'commentaire', a.commentaire,
                 'statut', a.statut,
                 'annotateur_id', a.annotateur_id,
                 'ecart_assistant', a.ecart_assistant,
                 'ecart_explication', a.ecart_explication,
                 'proposition_assistant', a.proposition_assistant,
                 'version_manuel', a.version_manuel,
                 'revision', a.revision,
                 'updated_at', a.updated_at
               ) ORDER BY a.place
             ) FILTER (WHERE a.id IS NOT NULL), '[]') AS annotations
      FROM bahyo_atelier_noyau n
      LEFT JOIN bahyo_atelier_annotation a ON a.noyau_id = n.id
      WHERE n.experience_id = $1
      GROUP BY n.id
      ORDER BY n.rang
    `, [id]);

    const { rows: groupes } = await query(`
      SELECT g.*,
             COALESCE(json_agg(gn.noyau_id) FILTER (WHERE gn.noyau_id IS NOT NULL), '[]') AS noyau_ids
      FROM bahyo_atelier_groupe g
      LEFT JOIN bahyo_atelier_groupe_noyau gn ON gn.groupe_id = g.id
      WHERE g.experience_id = $1
      GROUP BY g.id
      ORDER BY g.created_at
    `, [id]);

    const groupesDerives = await deriverGroupes(groupes);

    const { rows: manques } = await query(
      `SELECT * FROM bahyo_atelier_manque
       WHERE experience_id = $1 OR noyau_id IN (
         SELECT id FROM bahyo_atelier_noyau WHERE experience_id = $1
       )
       ORDER BY created_at`, [id]
    );

    res.json({ experience: exp[0], noyaux, groupes: groupesDerives, manques });
  } catch (err) {
    console.error('[ATELIER] Erreur experience detail:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ANNOTATIONS
// ═══════════════════════════════════════════════════════════════════════════

// POST /atelier/noyaux/:id/annotation  — upsert par (noyau, place, annotateur)
router.post('/noyaux/:id/annotation', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      place, regime, sous_categorie, identification,
      a_composer = false, champs_specifiques = null, commentaire = null,
      proposition_assistant = null, ecart_assistant = false,
      ecart_explication = null, statut = 'brouillon',
    } = req.body;

    if (!PLACES.includes(place)) {
      return res.status(400).json({ error: `place doit etre parmi ${PLACES.join(', ')}` });
    }
    if (regime && !REGIMES.includes(regime)) {
      return res.status(400).json({ error: `regime doit etre parmi ${REGIMES.join(', ')}` });
    }
    if (sous_categorie && !SOUS_CATEGORIES.includes(sous_categorie)) {
      return res.status(400).json({ error: `sous_categorie invalide` });
    }
    if (statut && !STATUTS_ANNOTATION.includes(statut)) {
      return res.status(400).json({ error: `statut invalide` });
    }
    // Regle d'application : un ecart avec l'assistant DOIT etre explicite (complement 3.2)
    if (ecart_assistant && (!ecart_explication || ecart_explication.trim().length < 10)) {
      return res.status(400).json({
        error: "Un ecart avec la proposition de l'assistant doit etre explicite (10 caracteres minimum)",
        code: 'ECART_NON_EXPLICITE',
      });
    }

    const vman = await versionManuel();

    const { rows } = await query(`
      INSERT INTO bahyo_atelier_annotation
        (noyau_id, place, annotateur_id, regime, sous_categorie, identification,
         a_composer, champs_specifiques, commentaire,
         proposition_assistant, ecart_assistant, ecart_explication, statut,
         version_manuel)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (noyau_id, place, annotateur_id) DO UPDATE SET
        regime = EXCLUDED.regime,
        sous_categorie = EXCLUDED.sous_categorie,
        identification = EXCLUDED.identification,
        a_composer = EXCLUDED.a_composer,
        champs_specifiques = EXCLUDED.champs_specifiques,
        commentaire = EXCLUDED.commentaire,
        proposition_assistant = COALESCE(EXCLUDED.proposition_assistant,
                                         bahyo_atelier_annotation.proposition_assistant),
        ecart_assistant = EXCLUDED.ecart_assistant,
        ecart_explication = EXCLUDED.ecart_explication,
        statut = EXCLUDED.statut,
        version_manuel = EXCLUDED.version_manuel,
        updated_at = NOW()
      RETURNING *
    `, [id, place, req.user.id, regime, sous_categorie, identification,
        a_composer, champs_specifiques, commentaire,
        proposition_assistant, ecart_assistant, ecart_explication, statut, vman]);

    // Rattache l'annotation aux tours de dialogue qu'elle vient clore (B.5)
    await query(`UPDATE bahyo_atelier_message
                 SET resultat_annotation_id = $1
                 WHERE noyau_id = $2 AND place = $3 AND resultat_annotation_id IS NULL`,
                [rows[0].id, id, place]);

    // Statut de l'experience (B.1)
    const { rows: ex } = await query(
      'SELECT experience_id FROM bahyo_atelier_noyau WHERE id = $1', [id]);
    if (ex[0]) await majStatutExperience(ex[0].experience_id);

    res.json({ annotation: rows[0] });
  } catch (err) {
    console.error('[ATELIER] Erreur annotation upsert:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MANQUES — coeur pedagogique
// ═══════════════════════════════════════════════════════════════════════════

router.post('/manques', async (req, res) => {
  try {
    const {
      noyau_id = null, experience_id = null, place = null,
      type_manque, description, question_type = null,
      criticite = 'souhaitable', detecte_par = 'annotateur',
    } = req.body;

    if (!type_manque || !description) {
      return res.status(400).json({ error: 'type_manque et description requis' });
    }
    if (!noyau_id && !experience_id) {
      return res.status(400).json({ error: 'noyau_id ou experience_id requis' });
    }

    const { rows } = await query(`
      INSERT INTO bahyo_atelier_manque
        (noyau_id, experience_id, place, type_manque, description,
         question_type, criticite, detecte_par, annotateur_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [noyau_id, experience_id, place, type_manque, description,
        question_type, criticite, detecte_par, req.user.id]);

    res.json({ manque: rows[0] });
  } catch (err) {
    console.error('[ATELIER] Erreur manque create:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /atelier/manques/:id — transition de statut / resolution (H.2)
modifier('/manques/:id', async (req, res) => {
  try {
    const { statut, resolution, description, question_type, criticite,
            manuel_section_ref } = req.body;
    if (statut && !STATUTS_MANQUE.includes(statut)) {
      return res.status(400).json({ error: `statut doit etre parmi ${STATUTS_MANQUE.join(', ')}` });
    }
    // Un manque resolu exige son texte de resolution (H.2)
    if (statut === 'resolu' && (!resolution || resolution.trim().length < 10)) {
      return res.status(400).json({
        error: 'Resoudre un manque exige un texte de resolution (10 caracteres minimum)',
        code: 'RESOLUTION_REQUISE',
      });
    }
    const vman = statut === 'resolu' ? await versionManuel() : null;
    const { rows } = await query(`
      UPDATE bahyo_atelier_manque SET
        statut = COALESCE($2, statut),
        resolution = COALESCE($3, resolution),
        description = COALESCE($4, description),
        question_type = COALESCE($5, question_type),
        criticite = COALESCE($6, criticite),
        manuel_section_ref = COALESCE($7, manuel_section_ref),
        manuel_version_ref = COALESCE($8, manuel_version_ref),
        resolu_par = CASE WHEN $2 = 'resolu' THEN $9 ELSE resolu_par END,
        resolu_at  = CASE WHEN $2 = 'resolu' THEN NOW() ELSE resolu_at END,
        updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [req.params.id, statut || null, resolution || null, description || null,
        question_type || null, criticite || null, manuel_section_ref || null,
        vman, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Manque introuvable' });
    res.json({ manque: rows[0] });
  } catch (err) {
    console.error('[ATELIER] Erreur manque update:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /atelier/manques/:id/historique
router.get('/manques/:id/historique', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT h.*, u.email AS auteur_email
       FROM bahyo_atelier_manque_historique h
       LEFT JOIN bahyo_user u ON u.id = h.auteur_id
       WHERE h.manque_id = $1 ORDER BY h.created_at`, [req.params.id]);
    res.json({ historique: rows });
  } catch (err) {
    console.error('[ATELIER] Erreur manque historique:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/manques/:id', async (req, res) => {
  try {
    await query('DELETE FROM bahyo_atelier_manque WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[ATELIER] Erreur manque delete:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /atelier/manques/repertoire
// Le repertoire des questions que BioCraft devra savoir poser.
router.get('/manques/repertoire', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT type_manque, criticite,
             COUNT(*) AS occurrences,
             array_agg(DISTINCT question_type) FILTER (WHERE question_type IS NOT NULL) AS questions
      FROM bahyo_atelier_manque
      GROUP BY type_manque, criticite
      ORDER BY occurrences DESC
    `);
    res.json({ repertoire: rows });
  } catch (err) {
    console.error('[ATELIER] Erreur repertoire:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GROUPES A3 (BS composites)
// ═══════════════════════════════════════════════════════════════════════════

router.post('/groupes', async (req, res) => {
  try {
    const {
      experience_id, tiers, tiers_source, finalite_exprimee = null,
      inscription_finalite, champ_pratique = null,
      libelle = null, justification = null,
      noyau_ids = [], modes_exclusion = [],
      origine = 'annotateur', proposition_assistant = null,
      statut = 'valide',
    } = req.body;

    if (!experience_id) return res.status(400).json({ error: 'experience_id requis' });
    if (inscription_finalite && !INSCRIPTIONS.includes(inscription_finalite)) {
      return res.status(400).json({ error: `inscription_finalite doit etre parmi ${INSCRIPTIONS.join(', ')}` });
    }
    // Regle du plafond latent (prompt A3 v0.2, regle 4) — porte desormais
    // sur inscription_finalite, inchangee sur le fond (P.3)
    if (tiers_source === 'implicite' && inscription_finalite === 'porte') {
      return res.status(400).json({
        error: "Un tiers implicite ne peut pas depasser 'latent'",
        code: 'PLAFOND_LATENT',
      });
    }

    if (statut && !STATUTS_GROUPE.includes(statut)) {
      return res.status(400).json({ error: `statut doit etre parmi ${STATUTS_GROUPE.join(', ')}` });
    }
    const vman = await versionManuel();

    // Chaque mode retenu exige sa justification (5.2)
    for (const m of modes_exclusion) {
      if (!m?.mode) return res.status(400).json({ error: 'mode requis' });
      if (!m.justification || m.justification.trim().length < 10) {
        return res.status(400).json({
          error: `Le mode « ${m.mode} » exige une justification (10 caracteres minimum)`,
          code: 'JUSTIFICATION_REQUISE',
        });
      }
      if (m.mode === 'autre' && !m.libelle_propose?.trim()) {
        return res.status(400).json({
          error: "Le mode « autre » exige un libelle propose",
          code: 'LIBELLE_REQUIS',
        });
      }
    }

    const groupe = await withTransaction(async (client) => {
      const { rows } = await client.query(`
        INSERT INTO bahyo_atelier_groupe
          (experience_id, tiers, tiers_source, finalite_exprimee,
           inscription_finalite, champ_pratique, libelle, justification,
           annotateur_id, origine, proposition_assistant, statut, version_manuel)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *
      `, [experience_id, tiers, tiers_source, finalite_exprimee,
          inscription_finalite, champ_pratique, libelle, justification,
          req.user.id, origine, proposition_assistant, statut, vman]);

      const g = rows[0];
      for (const nid of noyau_ids) {
        await client.query(
          `INSERT INTO bahyo_atelier_groupe_noyau (groupe_id, noyau_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`, [g.id, nid]
        );
      }
      for (const m of modes_exclusion) {
        await client.query(`
          INSERT INTO bahyo_atelier_mode_exclusion
            (groupe_id, mode, libelle_propose, justification, annotateur_id,
             pose_par, version_manuel)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (groupe_id, mode) DO NOTHING
        `, [g.id, m.mode, m.libelle_propose || null, m.justification,
            req.user.id, m.pose_par || 'annotateur', vman]);
      }
      return g;
    });

    // Le trigger 4.6 a pu ajouter 'sans_chaine_finalite' : on relit pour
    // renvoyer l'etat reel avec son statut derive.
    const [enrichi] = await deriverGroupes([groupe]);
    res.json({ groupe: enrichi });
  } catch (err) {
    console.error('[ATELIER] Erreur groupe create:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

modifier('/groupes/:id', async (req, res) => {
  try {
    const { libelle, justification, inscription_finalite, statut,
            finalite_exprimee, tiers, tiers_source, champ_pratique } = req.body;
    if (inscription_finalite && !INSCRIPTIONS.includes(inscription_finalite)) {
      return res.status(400).json({ error: 'inscription_finalite invalide' });
    }
    if (statut && !STATUTS_GROUPE.includes(statut)) {
      return res.status(400).json({ error: `statut doit etre parmi ${STATUTS_GROUPE.join(', ')}` });
    }
    // Plafond latent, y compris a la modification (P.3)
    const { rows: cur } = await query(
      'SELECT tiers_source, inscription_finalite FROM bahyo_atelier_groupe WHERE id = $1',
      [req.params.id]);
    if (!cur[0]) return res.status(404).json({ error: 'Groupe introuvable' });
    const srcFinal  = tiers_source ?? cur[0].tiers_source;
    const inscFinal = inscription_finalite ?? cur[0].inscription_finalite;
    if (srcFinal === 'implicite' && inscFinal === 'porte') {
      return res.status(400).json({
        error: "Un tiers implicite ne peut pas depasser 'latent'",
        code: 'PLAFOND_LATENT',
      });
    }

    const { rows } = await query(`
      UPDATE bahyo_atelier_groupe SET
        libelle = COALESCE($2, libelle),
        justification = COALESCE($3, justification),
        inscription_finalite = COALESCE($4, inscription_finalite),
        statut = COALESCE($5, statut),
        finalite_exprimee = COALESCE($6, finalite_exprimee),
        tiers = COALESCE($7, tiers),
        tiers_source = COALESCE($8, tiers_source),
        champ_pratique = COALESCE($9, champ_pratique),
        updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [req.params.id, libelle, justification, inscription_finalite, statut,
        finalite_exprimee, tiers, tiers_source, champ_pratique]);

    const [enrichi] = await deriverGroupes([rows[0]]);
    res.json({ groupe: enrichi });
  } catch (err) {
    console.error('[ATELIER] Erreur groupe update:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MODES D'EXCLUSION (specification du 22/09/2026)
//
//  L'annotateur ne juge jamais positivement. Il constate des exclusions ou
//  n'en constate pas ; potentiellement_performatif s'en derive.
// ═══════════════════════════════════════════════════════════════════════════

// POST /atelier/groupes/:id/exclusions
router.post('/groupes/:id/exclusions', async (req, res) => {
  try {
    const { mode, libelle_propose = null, justification,
            pose_par = 'annotateur' } = req.body;

    if (!mode) return res.status(400).json({ error: 'mode requis' });
    if (!POSE_PAR.includes(pose_par)) {
      return res.status(400).json({ error: `pose_par doit etre parmi ${POSE_PAR.join(', ')}` });
    }
    // Chaque mode retenu ouvre son champ de justification, obligatoire (5.2)
    if (!justification || justification.trim().length < 10) {
      return res.status(400).json({
        error: 'Chaque mode d\'exclusion exige sa justification (10 caracteres minimum)',
        code: 'JUSTIFICATION_REQUISE',
      });
    }
    // Pour le mode « autre », le libelle propose est egalement obligatoire (4.3)
    if (mode === 'autre' && !libelle_propose?.trim()) {
      return res.status(400).json({
        error: "Le mode « autre » exige un libelle propose, pour que le mode rencontre puisse etre nomme puis promu",
        code: 'LIBELLE_REQUIS',
      });
    }
    // Le mode doit exister au registre, sauf « autre » qui est la valeur ouverte
    const { rows: reg } = await query(
      'SELECT mode FROM bahyo_atelier_mode_registre WHERE mode = $1 AND actif = TRUE',
      [mode]);
    if (!reg[0]) {
      return res.status(400).json({
        error: `Mode « ${mode} » inconnu du registre. Utiliser « autre » avec un libelle propose.`,
        code: 'MODE_INCONNU',
      });
    }

    const { rows } = await query(`
      INSERT INTO bahyo_atelier_mode_exclusion
        (groupe_id, mode, libelle_propose, justification, annotateur_id,
         pose_par, version_manuel)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (groupe_id, mode) DO UPDATE SET
        libelle_propose = EXCLUDED.libelle_propose,
        justification = EXCLUDED.justification,
        annotateur_id = EXCLUDED.annotateur_id,
        pose_par = EXCLUDED.pose_par
      RETURNING *
    `, [req.params.id, mode, libelle_propose, justification.trim(),
        req.user.id, pose_par, await versionManuel()]);

    const { rows: g } = await query(
      'SELECT * FROM bahyo_atelier_groupe WHERE id = $1', [req.params.id]);
    const [enrichi] = await deriverGroupes(g);
    res.json({ exclusion: rows[0], groupe: enrichi });
  } catch (err) {
    console.error('[ATELIER] Erreur exclusion create:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// DELETE /atelier/exclusions/:id — le retrait est toujours permis ; si le
// groupe reste « atomise », l'incoherence est signalee, jamais bloquee (4.6).
router.delete('/exclusions/:id', async (req, res) => {
  try {
    const { rows: del } = await query(
      'DELETE FROM bahyo_atelier_mode_exclusion WHERE id = $1 RETURNING groupe_id',
      [req.params.id]);
    if (!del[0]) return res.status(404).json({ error: 'Exclusion introuvable' });

    const { rows: g } = await query(
      'SELECT * FROM bahyo_atelier_groupe WHERE id = $1', [del[0].groupe_id]);
    const [enrichi] = await deriverGroupes(g);
    res.json({
      ok: true,
      groupe: enrichi,
      avertissement: enrichi.incoherence_atomise
        ? "Ce groupe est qualifie « atomise » sans porter le mode « sans_chaine_finalite ». "
          + "Revisez l'inscription ou retablissez le mode."
        : null,
    });
  } catch (err) {
    console.error('[ATELIER] Erreur exclusion delete:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /atelier/exclusions/registre — modes reconnus + « autre » recurrents (4.4)
router.get('/exclusions/registre', async (req, res) => {
  try {
    const [reg, usage, autres] = await Promise.all([
      query(`SELECT * FROM bahyo_atelier_mode_registre ORDER BY ordre, mode`),
      query(`SELECT mode, COUNT(*) AS n FROM bahyo_atelier_mode_exclusion
             GROUP BY mode ORDER BY n DESC`),
      // Les libelles proposes recurrents meritent d'etre promus en mode de
      // premier rang — c'est ainsi que la morphologie du BS se decouvre.
      query(`SELECT libelle_propose, COUNT(*) AS n,
                    array_agg(DISTINCT groupe_id) AS groupes
             FROM bahyo_atelier_mode_exclusion
             WHERE mode = 'autre' AND libelle_propose IS NOT NULL
             GROUP BY libelle_propose ORDER BY n DESC`),
    ]);
    res.json({
      registre: reg.rows,
      usage: usage.rows,
      candidats_promotion: autres.rows,
    });
  } catch (err) {
    console.error('[ATELIER] Erreur registre:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /atelier/exclusions/registre — promouvoir un « autre » en mode nomme.
// Aucune migration des annotations existantes n'est requise (4.4).
router.post('/exclusions/registre', async (req, res) => {
  try {
    const { mode, libelle, definition = null, promu_depuis = null,
            quoi, ou, pourquoi } = req.body;
    if (!mode || !libelle) {
      return res.status(400).json({ error: 'mode et libelle requis' });
    }
    // Une promotion est une evolution des regles d'application : elle porte
    // son quoi, son ou et son pourquoi comme toute evolution du manuel.
    if (!quoi || !ou || !pourquoi) {
      return res.status(400).json({
        error: 'Toute promotion de mode doit porter son quoi, son ou et son pourquoi',
        code: 'TROIS_QUESTIONS',
      });
    }

    const resultat = await withTransaction(async (client) => {
      const { rows } = await client.query(`
        INSERT INTO bahyo_atelier_mode_registre
          (mode, libelle, definition, promu_depuis, promu_le, promu_par,
           quoi, ou, pourquoi, ordre)
        VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,
                COALESCE((SELECT MAX(ordre) + 10 FROM bahyo_atelier_mode_registre
                          WHERE mode <> 'autre'), 10))
        ON CONFLICT (mode) DO UPDATE SET
          libelle = EXCLUDED.libelle, definition = EXCLUDED.definition,
          actif = TRUE
        RETURNING *
      `, [mode, libelle, definition, promu_depuis, req.user.id, quoi, ou, pourquoi]);

      // Rebascule les entrees « autre » qui portaient ce libelle
      let reclasses = 0;
      if (promu_depuis) {
        const { rowCount } = await client.query(`
          UPDATE bahyo_atelier_mode_exclusion
          SET mode = $1, libelle_propose = NULL
          WHERE mode = 'autre' AND libelle_propose = $2
            AND NOT EXISTS (
              SELECT 1 FROM bahyo_atelier_mode_exclusion m2
              WHERE m2.groupe_id = bahyo_atelier_mode_exclusion.groupe_id
                AND m2.mode = $1)
        `, [mode, promu_depuis]);
        reclasses = rowCount;
      }
      return { registre: rows[0], reclasses };
    });

    res.json(resultat);
  } catch (err) {
    console.error('[ATELIER] Erreur promotion mode:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /atelier/groupes/:id/noyaux — recompose le groupe (G.2 : deplacer/retirer)
router.put('/groupes/:id/noyaux', async (req, res) => {
  try {
    const { noyau_ids } = req.body;
    if (!Array.isArray(noyau_ids)) {
      return res.status(400).json({ error: 'noyau_ids doit etre un tableau' });
    }
    await withTransaction(async (client) => {
      // Touche le groupe pour declencher l'archivage de la composition precedente
      await client.query(
        `UPDATE bahyo_atelier_groupe SET justification = COALESCE(justification, '')
         || '' , updated_at = NOW() WHERE id = $1`, [req.params.id]);
      await client.query('DELETE FROM bahyo_atelier_groupe_noyau WHERE groupe_id = $1',
                         [req.params.id]);
      for (const nid of noyau_ids) {
        await client.query(
          `INSERT INTO bahyo_atelier_groupe_noyau (groupe_id, noyau_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, nid]);
      }
      // Un noyau rattache n'est plus orphelin
      if (noyau_ids.length) {
        await client.query(
          `UPDATE bahyo_atelier_noyau SET statut_orphelin = 'rattache'
           WHERE id = ANY($1) AND statut_orphelin IS DISTINCT FROM 'confirme'`,
          [noyau_ids]);
      }
    });
    res.json({ ok: true, noyau_ids });
  } catch (err) {
    console.error('[ATELIER] Erreur groupe noyaux:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /atelier/noyaux/:id/orphelin — confirmer ou lever le statut (G.6)
modifier('/noyaux/:id/orphelin', async (req, res) => {
  try {
    const { statut_orphelin } = req.body;
    if (statut_orphelin !== null && !STATUTS_ORPHELIN.includes(statut_orphelin)) {
      return res.status(400).json({ error: `statut_orphelin doit etre parmi ${STATUTS_ORPHELIN.join(', ')}` });
    }
    const { rows } = await query(
      `UPDATE bahyo_atelier_noyau SET statut_orphelin = $2 WHERE id = $1
       RETURNING id, texte, statut_orphelin, sans_tiers_assistant`,
      [req.params.id, statut_orphelin]);
    if (!rows[0]) return res.status(404).json({ error: 'Noyau introuvable' });
    res.json({ noyau: rows[0] });
  } catch (err) {
    console.error('[ATELIER] Erreur orphelin:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PATCH /atelier/experiences/:id/statut — marquage manuel, dont 'a_revoir' (M.3)
modifier('/experiences/:id/statut', async (req, res) => {
  try {
    const { statut } = req.body;
    if (!STATUTS_EXPERIENCE.includes(statut)) {
      return res.status(400).json({ error: `statut doit etre parmi ${STATUTS_EXPERIENCE.join(', ')}` });
    }
    const { rows } = await query(
      'UPDATE bahyo_atelier_experience SET statut = $2 WHERE id = $1 RETURNING id, statut',
      [req.params.id, statut]);
    if (!rows[0]) return res.status(404).json({ error: 'Experience introuvable' });
    res.json({ experience: rows[0] });
  } catch (err) {
    console.error('[ATELIER] Erreur statut experience:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ASSISTANT (Mistral)
// ═══════════════════════════════════════════════════════════════════════════

// POST /atelier/experiences/:id/passage-a3
// Lance le prompt A3 sur l'experience, enregistre le passage, cree les groupes
// proposes en statut 'candidat' (origine 'assistant') que l'annotateur validera.
router.post('/experiences/:id/passage-a3', async (req, res) => {
  try {
    const { id } = req.params;
    const creerGroupes = req.body?.creer_groupes !== false;

    const { rows: exp } = await query(
      'SELECT id, texte_source FROM bahyo_atelier_experience WHERE id = $1', [id]
    );
    if (!exp[0]) return res.status(404).json({ error: 'Experience introuvable' });
    if (!exp[0].texte_source?.trim()) {
      return res.status(400).json({ error: 'Texte source vide : experience non exploitable' });
    }

    const { rows: noyaux } = await query(
      'SELECT id, texte FROM bahyo_atelier_noyau WHERE experience_id = $1 ORDER BY rang', [id]
    );
    if (!noyaux.length) return res.status(400).json({ error: 'Aucun noyau sur cette experience' });

    const r = await mistral.passageA3(exp[0].texte_source, noyaux.map(n => n.texte));

    const { rows: passage } = await query(`
      INSERT INTO bahyo_atelier_passage
        (experience_id, place, modele, prompt_version, sortie_brute, sortie_json,
         statut, duree_s, tokens_in, tokens_out)
      VALUES ($1,'A3',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [id, r.modele, mistral.PROMPT_A3_VERSION, r.sortie_brute,
        r.sortie_json, r.statut, r.duree_s, r.tokens_in, r.tokens_out]);

    const vmanA3 = await versionManuel();
    let groupesCrees = [];
    let sansGroupe = [];
    if (creerGroupes && r.statut === 'ok' && Array.isArray(r.sortie_json?.groupes)) {
      // Index texte -> id pour rattacher les noyaux nommes par le modele
      const parTexte = new Map(noyaux.map(n => [n.texte.trim(), n.id]));

      for (const g of r.sortie_json.groupes) {
        // Le prompt A3 v0.2 renvoie encore la cle potentiel_performatif ;
        // sa semantique est exactement celle d'inscription_finalite.
        const brut = g.inscription_finalite ?? g.potentiel_performatif;
        let insc = INSCRIPTIONS.includes(brut) ? brut : 'atomise';
        // Application defensive du plafond latent
        if (g.tiers_source === 'implicite' && insc === 'porte') insc = 'latent';

        const { rows: gr } = await query(`
          INSERT INTO bahyo_atelier_groupe
            (experience_id, tiers, tiers_source, finalite_exprimee,
             inscription_finalite, origine, proposition_assistant, statut,
             version_manuel)
          VALUES ($1,$2,$3,$4,$5,'assistant',$6,'proposition',$7) RETURNING *
        `, [id, g.tiers ?? null, g.tiers_source ?? null,
            g.finalite_exprimee ?? null, insc, g, vmanA3]);

        for (const nt of (g.noyaux || [])) {
          const nid = parTexte.get(String(nt).trim());
          if (nid) {
            await query(
              `INSERT INTO bahyo_atelier_groupe_noyau (groupe_id, noyau_id)
               VALUES ($1,$2) ON CONFLICT DO NOTHING`, [gr[0].id, nid]
            );
          }
        }
        groupesCrees.push(gr[0]);
      }

      // G.1 / G.6 — les noyaux que l'assistant declare sans tiers, et ceux qui
      // restent hors de tout groupe, deviennent candidats orphelins.
      // Ils ne sont plus jetes silencieusement.
      const nomsSansTiers = (r.sortie_json.noyaux_sans_tiers || [])
        .map(t => parTexte.get(String(t).trim())).filter(Boolean);

      const { rows: rattaches } = await query(
        `SELECT DISTINCT gn.noyau_id FROM bahyo_atelier_groupe_noyau gn
         JOIN bahyo_atelier_groupe g ON g.id = gn.groupe_id
         WHERE g.experience_id = $1`, [id]);
      const idsRattaches = new Set(rattaches.map(x => x.noyau_id));
      const orphelins = noyaux.map(n => n.id).filter(nid => !idsRattaches.has(nid));

      if (nomsSansTiers.length) {
        await query(`UPDATE bahyo_atelier_noyau SET sans_tiers_assistant = TRUE
                     WHERE id = ANY($1)`, [nomsSansTiers]);
      }
      if (orphelins.length) {
        await query(`UPDATE bahyo_atelier_noyau SET statut_orphelin = 'candidat'
                     WHERE id = ANY($1) AND statut_orphelin IS NULL`, [orphelins]);
      }
      if (idsRattaches.size) {
        await query(`UPDATE bahyo_atelier_noyau SET statut_orphelin = 'rattache'
                     WHERE id = ANY($1) AND statut_orphelin IS DISTINCT FROM 'confirme'`,
                    [[...idsRattaches]]);
      }

      sansGroupe = noyaux.filter(n => orphelins.includes(n.id))
                         .map(n => ({ id: n.id, texte: n.texte }));
    }

    const groupesDerives = await deriverGroupes(groupesCrees);
    res.json({ passage: passage[0], groupes: groupesDerives,
               noyaux_sans_groupe: sansGroupe });
  } catch (err) {
    console.error('[ATELIER] Erreur passage A3:', err.message);
    res.status(502).json({ error: `Assistant indisponible : ${err.message}` });
  }
});

// POST /atelier/noyaux/:id/proposition-a1
router.post('/noyaux/:id/proposition-a1', async (req, res) => {
  try {
    const { id } = req.params;

    const { rows } = await query(`
      SELECT n.texte, e.texte_source
      FROM bahyo_atelier_noyau n
      JOIN bahyo_atelier_experience e ON e.id = n.experience_id
      WHERE n.id = $1
    `, [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Noyau introuvable' });

    // Cas similaires : recouvrement lexical sur les mots porteurs, deja valides
    const mots = rows[0].texte.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    let similaires = [];
    if (mots.length) {
      const { rows: sim } = await query(`
        SELECT n2.texte, a.regime, a.identification
        FROM bahyo_atelier_annotation a
        JOIN bahyo_atelier_noyau n2 ON n2.id = a.noyau_id
        WHERE a.place = 'A1' AND a.statut = 'valide' AND n2.id <> $1
          AND n2.texte ILIKE ANY($2)
        ORDER BY a.updated_at DESC
        LIMIT 5
      `, [id, mots.map(m => `%${m}%`)]);
      similaires = sim;
    }

    const r = await mistral.propositionA1(rows[0].texte, rows[0].texte_source, similaires);

    await query(`
      INSERT INTO bahyo_atelier_passage
        (experience_id, place, modele, prompt_version, sortie_brute, sortie_json,
         statut, duree_s, tokens_in, tokens_out)
      SELECT experience_id,'A1',$2,'a1-v1',$3,$4,$5,$6,$7,$8
      FROM bahyo_atelier_noyau WHERE id = $1
    `, [id, r.modele, r.sortie_brute, r.sortie_json, r.statut,
        r.duree_s, r.tokens_in, r.tokens_out]);

    res.json({ proposition: r.sortie_json, statut: r.statut, brut: r.sortie_brute, cas_similaires: similaires });
  } catch (err) {
    console.error('[ATELIER] Erreur proposition A1:', err.message);
    res.status(502).json({ error: `Assistant indisponible : ${err.message}` });
  }
});

// POST /atelier/dialogue  — echange libre avec l'assistant, persiste
router.post('/dialogue', async (req, res) => {
  try {
    const { noyau_id = null, experience_id = null, groupe_id = null,
            place = null, message, registre = null } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message requis' });

    // Contexte du cas (F.1) et tracabilite documentaire (B.5)
    let contexte = '';
    const docsConsultes = [];
    const vman = await versionManuel();
    if (noyau_id) {
      const { rows } = await query(`
        SELECT n.texte, n.id AS nid, e.id AS eid, e.texte_source, e.poste, e.secteur
        FROM bahyo_atelier_noyau n
        JOIN bahyo_atelier_experience e ON e.id = n.experience_id
        WHERE n.id = $1`, [noyau_id]);
      if (rows[0]) {
        const c = rows[0];
        // F.1 : l'assistant doit disposer du texte source COMPLET, des autres
        // noyaux de l'experience, des annotations deja posees et de la version
        // des regles d'application en vigueur.
        const [freres, posees] = await Promise.all([
          query(`SELECT texte FROM bahyo_atelier_noyau
                 WHERE experience_id = $1 AND id <> $2 ORDER BY rang`, [c.eid, c.nid]),
          query(`SELECT place, regime, sous_categorie, identification
                 FROM bahyo_atelier_annotation WHERE noyau_id = $1 ORDER BY place`, [c.nid]),
        ]);
        const bloc = [
          `Version des regles d'application en vigueur : v${vman}`,
          `Poste : ${c.poste}`,
          `Secteur : ${c.secteur}`,
          '',
          'TEXTE SOURCE COMPLET :',
          '---',
          c.texte_source || '(vide)',
          '---',
          '',
          `NOYAU EN COURS DE QUALIFICATION : "${c.texte}"`,
        ];
        if (freres.rows.length) {
          bloc.push('', 'AUTRES NOYAUX DE LA MEME EXPERIENCE :',
                    ...freres.rows.map(f => `- ${f.texte}`));
        }
        bloc.push('', posees.rows.length
          ? 'ANNOTATIONS DEJA POSEES SUR CE NOYAU :'
          : 'Aucune annotation encore posee sur ce noyau.');
        for (const a of posees.rows) {
          bloc.push(`- ${a.place} : regime=${a.regime || '?'}`
            + (a.sous_categorie ? ` (${a.sous_categorie})` : '')
            + (a.identification ? `, identification=${a.identification}` : ''));
        }
        contexte = bloc.join('\n');
        docsConsultes.push(`manuel@v${vman}`, `experience:${c.eid}`);
      }
    }

    // Historique
    const { rows: hist } = await query(`
      SELECT role, contenu FROM bahyo_atelier_message
      WHERE ($1::uuid IS NULL OR noyau_id = $1)
        AND ($2::uuid IS NULL OR experience_id = $2)
        AND ($3::uuid IS NULL OR groupe_id = $3)
        AND role <> 'systeme'
      ORDER BY tour NULLS LAST, created_at LIMIT 30
    `, [noyau_id, experience_id, groupe_id]);

    const tourBase = hist.length;

    // Persiste le message de l'annotateur
    await query(`
      INSERT INTO bahyo_atelier_message
        (experience_id, noyau_id, groupe_id, place, role, type_dialogue, registre,
         contenu, version_manuel, tour)
      VALUES ($1,$2,$3,$4,'annotateur','avec_annotateur',$5,$6,$7,$8)
    `, [experience_id, noyau_id, groupe_id, place, registre, message, vman, tourBase + 1]);

    const r = await mistral.dialogue([...hist, { role: 'annotateur', contenu: message }], contexte);

    await query(`
      INSERT INTO bahyo_atelier_message
        (experience_id, noyau_id, groupe_id, place, role, type_dialogue, registre,
         contenu, modele, version_manuel, tour, documents_consultes)
      VALUES ($1,$2,$3,$4,'assistant','avec_annotateur',$5,$6,$7,$8,$9,$10)
    `, [experience_id, noyau_id, groupe_id, place, registre, r.contenu, r.modele,
        vman, tourBase + 2, JSON.stringify(docsConsultes)]);

    res.json({ reponse: r.contenu, modele: r.modele, duree_s: r.duree_s,
               version_manuel: vman, documents_consultes: docsConsultes });
  } catch (err) {
    console.error('[ATELIER] Erreur dialogue:', err.message);
    res.status(502).json({ error: `Assistant indisponible : ${err.message}` });
  }
});

// GET /atelier/messages?noyau_id=&experience_id=
router.get('/messages', async (req, res) => {
  try {
    const { noyau_id = null, experience_id = null, groupe_id = null } = req.query;
    const { rows } = await query(`
      SELECT * FROM bahyo_atelier_message
      WHERE ($1::uuid IS NULL OR noyau_id = $1)
        AND ($2::uuid IS NULL OR experience_id = $2)
        AND ($3::uuid IS NULL OR groupe_id = $3)
      ORDER BY tour NULLS LAST, created_at
    `, [noyau_id || null, experience_id || null, groupe_id || null]);
    res.json({ messages: rows });
  } catch (err) {
    console.error('[ATELIER] Erreur messages:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  CATALOGUE (memoire operationnelle)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/catalogue', async (req, res) => {
  try {
    const { regime, place = 'A1', q } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

    const params = [place];
    let filtre = '';
    if (regime) { params.push(regime); filtre += ` AND a.regime = $${params.length}`; }
    if (q) {
      params.push(`%${q}%`);
      filtre += ` AND (n.texte ILIKE $${params.length} OR a.identification ILIKE $${params.length})`;
    }
    params.push(limit);

    const { rows } = await query(`
      SELECT a.id, a.place, a.regime, a.sous_categorie, a.identification,
             a.a_composer, a.commentaire, a.statut, a.updated_at,
             n.id AS noyau_id, n.texte AS noyau_texte,
             e.poste, e.secteur
      FROM bahyo_atelier_annotation a
      JOIN bahyo_atelier_noyau      n ON n.id = a.noyau_id
      JOIN bahyo_atelier_experience e ON e.id = n.experience_id
      WHERE a.place = $1 AND a.statut = 'valide' ${filtre}
      ORDER BY a.updated_at DESC
      LIMIT $${params.length}
    `, params);

    res.json({ catalogue: rows });
  } catch (err) {
    console.error('[ATELIER] Erreur catalogue:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  MANUEL VIVANT
// ═══════════════════════════════════════════════════════════════════════════

router.get('/manuel', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM bahyo_atelier_manuel ORDER BY ordre, titre'
    );
    res.json({ sections: rows });
  } catch (err) {
    console.error('[ATELIER] Erreur manuel:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// PUT /atelier/manuel/:cle — les trois questions sont obligatoires (cahier 5.2)
router.put('/manuel/:cle', async (req, res) => {
  try {
    const { titre, contenu_md, ordre = 0, quoi, ou, pourquoi } = req.body;
    if (!titre || !contenu_md) {
      return res.status(400).json({ error: 'titre et contenu_md requis' });
    }
    if (!quoi || !ou || !pourquoi) {
      return res.status(400).json({
        error: 'Toute evolution du manuel doit porter son quoi, son ou et son pourquoi',
        code: 'TROIS_QUESTIONS',
      });
    }
    const section = await withTransaction(async (client) => {
      const cle = req.params.cle;

      // Etat courant avant modification
      const { rows: av } = await client.query(
        'SELECT * FROM bahyo_atelier_manuel WHERE section_cle = $1', [cle]);

      // Version globale des regles d'application : +1 a chaque evolution (B.7)
      const { rows: vc } = await client.query(
        "SELECT valeur FROM bahyo_config WHERE cle = 'atelier_manuel_version' FOR UPDATE");
      const vGlobale = (vc[0] ? parseInt(vc[0].valeur, 10) : 1) + 1;
      await client.query(
        `INSERT INTO bahyo_config (cle, valeur) VALUES ('atelier_manuel_version', $1)
         ON CONFLICT (cle) DO UPDATE SET valeur = $1`, [String(vGlobale)]);

      const vSection = av[0] ? av[0].version + 1 : 1;

      // Clot la version precedente
      if (av[0]) {
        await client.query(
          `UPDATE bahyo_atelier_manuel_version SET valide_a = NOW()
           WHERE section_cle = $1 AND valide_a IS NULL`, [cle]);
      }

      const { rows } = await client.query(`
        INSERT INTO bahyo_atelier_manuel
          (section_cle, titre, contenu_md, ordre, version, updated_par,
           dernier_quoi, dernier_ou, dernier_pourquoi)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (section_cle) DO UPDATE SET
          titre = EXCLUDED.titre,
          contenu_md = EXCLUDED.contenu_md,
          ordre = EXCLUDED.ordre,
          version = EXCLUDED.version,
          updated_par = EXCLUDED.updated_par,
          dernier_quoi = EXCLUDED.dernier_quoi,
          dernier_ou = EXCLUDED.dernier_ou,
          dernier_pourquoi = EXCLUDED.dernier_pourquoi,
          updated_at = NOW()
        RETURNING *
      `, [cle, titre, contenu_md, ordre, vSection, req.user.id, quoi, ou, pourquoi]);

      // Fige la nouvelle version dans l'historique (J.4 / M.2)
      await client.query(`
        INSERT INTO bahyo_atelier_manuel_version
          (section_cle, version, version_globale, titre, contenu_md,
           quoi, ou, pourquoi, auteur_id, valide_de)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      `, [cle, vSection, vGlobale, titre, contenu_md, quoi, ou, pourquoi, req.user.id]);

      return { ...rows[0], version_globale: vGlobale };
    });

    res.json({ section });
  } catch (err) {
    console.error('[ATELIER] Erreur manuel update:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /atelier/manuel/:cle/versions — historique d'une section (J.4)
router.get('/manuel/:cle/versions', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT v.*, u.email AS auteur_email
      FROM bahyo_atelier_manuel_version v
      LEFT JOIN bahyo_user u ON u.id = v.auteur_id
      WHERE v.section_cle = $1 ORDER BY v.version DESC`, [req.params.cle]);
    res.json({ versions: rows });
  } catch (err) {
    console.error('[ATELIER] Erreur manuel versions:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /atelier/annotations/:id/historique — toutes les revisions (E.6)
router.get('/annotations/:id/historique', async (req, res) => {
  try {
    const [cour, hist] = await Promise.all([
      query(`SELECT a.*, u.email AS annotateur_email
             FROM bahyo_atelier_annotation a
             LEFT JOIN bahyo_user u ON u.id = a.annotateur_id
             WHERE a.id = $1`, [req.params.id]),
      query(`SELECT h.*, u.email AS annotateur_email
             FROM bahyo_atelier_annotation_historique h
             LEFT JOIN bahyo_user u ON u.id = h.annotateur_id
             WHERE h.annotation_id = $1 ORDER BY h.revision DESC`, [req.params.id]),
    ]);
    if (!cour.rows[0]) return res.status(404).json({ error: 'Annotation introuvable' });
    res.json({ courante: cour.rows[0], historique: hist.rows });
  } catch (err) {
    console.error('[ATELIER] Erreur annotation historique:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  STATISTIQUES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/stats', async (req, res) => {
  try {
    const [global, parRegime, parPerf, manques, ecarts] = await Promise.all([
      query(`SELECT
               (SELECT COUNT(*) FROM bahyo_atelier_experience) AS experiences,
               (SELECT COUNT(*) FROM bahyo_atelier_noyau)      AS noyaux,
               (SELECT COUNT(*) FROM bahyo_atelier_annotation) AS annotations,
               (SELECT COUNT(*) FROM bahyo_atelier_annotation WHERE statut='valide') AS validees,
               (SELECT COUNT(*) FROM bahyo_atelier_groupe)     AS groupes,
               (SELECT COUNT(*) FROM bahyo_atelier_manque)     AS manques`),
      query(`SELECT place, regime, COUNT(*) AS n FROM bahyo_atelier_annotation
             WHERE regime IS NOT NULL GROUP BY place, regime ORDER BY place, n DESC`),
      query(`SELECT inscription_finalite, statut, COUNT(*) AS n FROM bahyo_atelier_groupe
             GROUP BY 1,2 ORDER BY n DESC`),
      query(`SELECT type_manque, COUNT(*) AS n FROM bahyo_atelier_manque
             GROUP BY 1 ORDER BY n DESC LIMIT 12`),
      query(`SELECT COUNT(*) AS n FROM bahyo_atelier_annotation WHERE ecart_assistant = TRUE`),
    ]);

    res.json({
      global: global.rows[0],
      par_regime: parRegime.rows,
      par_inscription: parPerf.rows,
      top_manques: manques.rows,
      ecarts_assistant: parseInt(ecarts.rows[0].n, 10),
    });
  } catch (err) {
    console.error('[ATELIER] Erreur stats:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
