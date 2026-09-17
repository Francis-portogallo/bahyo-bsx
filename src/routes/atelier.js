// src/routes/atelier.js
// @version 1.0.0
// @date    2026-09-17
// @change  1.0.0 — Atelier d'annotation BS. Routes protegees par requireAnnotateur.
//                  Corpus / experiences / noyaux / annotations / manques /
//                  groupes A3 / dialogue assistant / manuel vivant / stats.
//                  Assistant : Mistral via src/services/mistral.js (remplacable
//                  par le SLM entraine sans toucher aux routes).
// ============================================================================
import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import * as mistral from '../services/mistral.js';

const router = Router();

// ── Vocabulaire normalise (aligne prompt A3 v0.2 + cahier de conception) ─────
const REGIMES = ['declaratif', 'constatif', 'orphelin'];
const SOUS_CATEGORIES = ['fonctionnel', 'relationnel'];
const POTENTIELS = ['porte', 'latent', 'atomise'];
const PLACES = ['A1', 'A2', 'A3'];
const STATUTS_ANNOTATION = ['brouillon', 'valide', 'litigieux', 'a_revoir'];
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
  { code: 'autre',               label: 'Autre' },
];

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

// ═══════════════════════════════════════════════════════════════════════════
//  REFERENTIEL
// ═══════════════════════════════════════════════════════════════════════════

router.get('/referentiel', (req, res) => {
  res.json({
    regimes: REGIMES,
    sous_categories: SOUS_CATEGORIES,
    potentiels_performatifs: POTENTIELS,
    places: PLACES,
    statuts_annotation: STATUTS_ANNOTATION,
    types_manque: TYPES_MANQUE,
    prompt_a3_version: mistral.PROMPT_A3_VERSION,
  });
});

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
    const { corpus_id, categorie, statut = 'tous' } = req.query;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;

    const where = [];
    const params = [];
    if (corpus_id) { params.push(corpus_id); where.push(`e.corpus_id = $${params.length}`); }
    if (categorie) { params.push(categorie); where.push(`e.categorie = $${params.length}`); }

    let having = '';
    if (statut === 'vierge')   having = 'HAVING COUNT(a.id) = 0';
    if (statut === 'en_cours') having = 'HAVING COUNT(a.id) > 0 AND COUNT(a.id) < COUNT(DISTINCT n.id) * 3';
    if (statut === 'complet')  having = 'HAVING COUNT(a.id) >= COUNT(DISTINCT n.id) * 3';

    params.push(limit, offset);

    const { rows } = await query(`
      SELECT e.id, e.profil_ref, e.poste, e.secteur, e.categorie,
             LEFT(e.texte_source, 240) AS extrait,
             e.semes_detectes,
             COUNT(DISTINCT n.id) AS nb_noyaux,
             COUNT(a.id)          AS nb_annotations,
             COUNT(DISTINCT g.id) AS nb_groupes
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

    res.json({ experiences: rows, limit, offset });
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
                 'proposition_assistant', a.proposition_assistant,
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

    const { rows: manques } = await query(
      `SELECT * FROM bahyo_atelier_manque
       WHERE experience_id = $1 OR noyau_id IN (
         SELECT id FROM bahyo_atelier_noyau WHERE experience_id = $1
       )
       ORDER BY created_at`, [id]
    );

    res.json({ experience: exp[0], noyaux, groupes, manques });
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
    // Regle doctrinale : un ecart avec l'assistant DOIT etre explicite (complement 3.2)
    if (ecart_assistant && (!ecart_explication || ecart_explication.trim().length < 10)) {
      return res.status(400).json({
        error: "Un ecart avec la proposition de l'assistant doit etre explicite (10 caracteres minimum)",
        code: 'ECART_NON_EXPLICITE',
      });
    }

    const { rows } = await query(`
      INSERT INTO bahyo_atelier_annotation
        (noyau_id, place, annotateur_id, regime, sous_categorie, identification,
         a_composer, champs_specifiques, commentaire,
         proposition_assistant, ecart_assistant, ecart_explication, statut)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
        updated_at = NOW()
      RETURNING *
    `, [id, place, req.user.id, regime, sous_categorie, identification,
        a_composer, champs_specifiques, commentaire,
        proposition_assistant, ecart_assistant, ecart_explication, statut]);

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
      potentiel_performatif, libelle = null, justification = null,
      noyau_ids = [], origine = 'annotateur', proposition_assistant = null,
      statut = 'candidat',
    } = req.body;

    if (!experience_id) return res.status(400).json({ error: 'experience_id requis' });
    if (potentiel_performatif && !POTENTIELS.includes(potentiel_performatif)) {
      return res.status(400).json({ error: `potentiel_performatif doit etre parmi ${POTENTIELS.join(', ')}` });
    }
    // Regle du plafond latent (prompt A3 v0.2, regle 4)
    if (tiers_source === 'implicite' && potentiel_performatif === 'porte') {
      return res.status(400).json({
        error: "Un tiers implicite ne peut pas depasser 'latent'",
        code: 'PLAFOND_LATENT',
      });
    }

    const groupe = await withTransaction(async (client) => {
      const { rows } = await client.query(`
        INSERT INTO bahyo_atelier_groupe
          (experience_id, tiers, tiers_source, finalite_exprimee,
           potentiel_performatif, libelle, justification, annotateur_id,
           origine, proposition_assistant, statut)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
      `, [experience_id, tiers, tiers_source, finalite_exprimee,
          potentiel_performatif, libelle, justification, req.user.id,
          origine, proposition_assistant, statut]);

      const g = rows[0];
      for (const nid of noyau_ids) {
        await client.query(
          `INSERT INTO bahyo_atelier_groupe_noyau (groupe_id, noyau_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`, [g.id, nid]
        );
      }
      return g;
    });

    res.json({ groupe });
  } catch (err) {
    console.error('[ATELIER] Erreur groupe create:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.patch('/groupes/:id', async (req, res) => {
  try {
    const { libelle, justification, potentiel_performatif, statut, finalite_exprimee } = req.body;
    if (potentiel_performatif && !POTENTIELS.includes(potentiel_performatif)) {
      return res.status(400).json({ error: 'potentiel_performatif invalide' });
    }
    const { rows } = await query(`
      UPDATE bahyo_atelier_groupe SET
        libelle = COALESCE($2, libelle),
        justification = COALESCE($3, justification),
        potentiel_performatif = COALESCE($4, potentiel_performatif),
        statut = COALESCE($5, statut),
        finalite_exprimee = COALESCE($6, finalite_exprimee),
        updated_at = NOW()
      WHERE id = $1 RETURNING *
    `, [req.params.id, libelle, justification, potentiel_performatif, statut, finalite_exprimee]);
    if (!rows[0]) return res.status(404).json({ error: 'Groupe introuvable' });
    res.json({ groupe: rows[0] });
  } catch (err) {
    console.error('[ATELIER] Erreur groupe update:', err.message);
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

    let groupesCrees = [];
    if (creerGroupes && r.statut === 'ok' && Array.isArray(r.sortie_json?.groupes)) {
      // Index texte -> id pour rattacher les noyaux nommes par le modele
      const parTexte = new Map(noyaux.map(n => [n.texte.trim(), n.id]));

      for (const g of r.sortie_json.groupes) {
        let perf = POTENTIELS.includes(g.potentiel_performatif) ? g.potentiel_performatif : 'atomise';
        // Application defensive du plafond latent
        if (g.tiers_source === 'implicite' && perf === 'porte') perf = 'latent';

        const { rows: gr } = await query(`
          INSERT INTO bahyo_atelier_groupe
            (experience_id, tiers, tiers_source, finalite_exprimee,
             potentiel_performatif, origine, proposition_assistant, statut)
          VALUES ($1,$2,$3,$4,$5,'assistant',$6,'candidat') RETURNING *
        `, [id, g.tiers ?? null, g.tiers_source ?? null,
            g.finalite_exprimee ?? null, perf, g]);

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
    }

    res.json({ passage: passage[0], groupes: groupesCrees });
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

    // Contexte du cas
    let contexte = '';
    if (noyau_id) {
      const { rows } = await query(`
        SELECT n.texte, e.texte_source, e.poste, e.secteur
        FROM bahyo_atelier_noyau n
        JOIN bahyo_atelier_experience e ON e.id = n.experience_id
        WHERE n.id = $1`, [noyau_id]);
      if (rows[0]) {
        contexte = `Noyau : "${rows[0].texte}"\nPoste : ${rows[0].poste}\nSecteur : ${rows[0].secteur}\nTexte source :\n"""\n${rows[0].texte_source}\n"""`;
      }
    }

    // Historique
    const { rows: hist } = await query(`
      SELECT role, contenu FROM bahyo_atelier_message
      WHERE ($1::uuid IS NULL OR noyau_id = $1)
        AND ($2::uuid IS NULL OR experience_id = $2)
        AND ($3::uuid IS NULL OR groupe_id = $3)
        AND role <> 'systeme'
      ORDER BY created_at LIMIT 30
    `, [noyau_id, experience_id, groupe_id]);

    // Persiste le message de l'annotateur
    await query(`
      INSERT INTO bahyo_atelier_message
        (experience_id, noyau_id, groupe_id, place, role, type_dialogue, registre, contenu)
      VALUES ($1,$2,$3,$4,'annotateur','annotateur',$5,$6)
    `, [experience_id, noyau_id, groupe_id, place, registre, message]);

    const r = await mistral.dialogue([...hist, { role: 'annotateur', contenu: message }], contexte);

    await query(`
      INSERT INTO bahyo_atelier_message
        (experience_id, noyau_id, groupe_id, place, role, type_dialogue, registre, contenu, modele)
      VALUES ($1,$2,$3,$4,'assistant','annotateur',$5,$6,$7)
    `, [experience_id, noyau_id, groupe_id, place, registre, r.contenu, r.modele]);

    res.json({ reponse: r.contenu, modele: r.modele, duree_s: r.duree_s });
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
      ORDER BY created_at
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
    const { rows } = await query(`
      INSERT INTO bahyo_atelier_manuel
        (section_cle, titre, contenu_md, ordre, updated_par,
         dernier_quoi, dernier_ou, dernier_pourquoi)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (section_cle) DO UPDATE SET
        titre = EXCLUDED.titre,
        contenu_md = EXCLUDED.contenu_md,
        ordre = EXCLUDED.ordre,
        updated_par = EXCLUDED.updated_par,
        dernier_quoi = EXCLUDED.dernier_quoi,
        dernier_ou = EXCLUDED.dernier_ou,
        dernier_pourquoi = EXCLUDED.dernier_pourquoi,
        updated_at = NOW()
      RETURNING *
    `, [req.params.cle, titre, contenu_md, ordre, req.user.id, quoi, ou, pourquoi]);
    res.json({ section: rows[0] });
  } catch (err) {
    console.error('[ATELIER] Erreur manuel update:', err.message);
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
      query(`SELECT potentiel_performatif, statut, COUNT(*) AS n FROM bahyo_atelier_groupe
             GROUP BY 1,2 ORDER BY n DESC`),
      query(`SELECT type_manque, COUNT(*) AS n FROM bahyo_atelier_manque
             GROUP BY 1 ORDER BY n DESC LIMIT 12`),
      query(`SELECT COUNT(*) AS n FROM bahyo_atelier_annotation WHERE ecart_assistant = TRUE`),
    ]);

    res.json({
      global: global.rows[0],
      par_regime: parRegime.rows,
      par_potentiel: parPerf.rows,
      top_manques: manques.rows,
      ecarts_assistant: parseInt(ecarts.rows[0].n, 10),
    });
  } catch (err) {
    console.error('[ATELIER] Erreur stats:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
