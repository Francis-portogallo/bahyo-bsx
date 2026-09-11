// src/routes/portfolio.js
// @version 1.1.0
// @date    2026-08-26
// @change  1.1.0 — GET /me : retire embedding_calcule inexistant du SELECT
//                  + ajoute source_nom dans bioskills (via jointure, si un jour
//                  source_id est ajoute a bahyo_portfolio_bs_extrait ; pour
//                  l'instant null par defaut). Ajout POST /bs/manuel : saisie
//                  BS manuelle par l'utilisateur + blocs etendus optionnels.
//          1.0.0 — Version initiale : Etage 1 portefeuille brut (extraction).
// ============================================================================
import { Router } from 'express';
import crypto from 'crypto';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, auditLog } from '../middleware/auth.js';

const router = Router();

const EXTRACTION_URL =
  process.env.EXTRACTION_API_URL || process.env.M4_API_URL || 'http://127.0.0.1:8000';

const POIDS_FORCE = { verifiee: 100, potentielle: 60, detaillee: 35, candidat: 15 };

function normaliserForce(f) {
  return POIDS_FORCE[f] !== undefined ? f : 'candidat';
}

// ─── GET /portfolio/me ────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const { rows: portfolio } = await query(
      `SELECT p.*, w.solde AS solde_bah
       FROM bahyo_portfolio_user p
       LEFT JOIN bahyo_token_wallet w ON w.user_id = p.user_id
       WHERE p.user_id = $1`,
      [userId]
    );
    if (!portfolio[0]) {
      return res.status(404).json({ error: 'Portefeuille introuvable' });
    }

    const { rows: retenus } = await query(
      `SELECT id, ref_locale, aptitude, acte, verdict, force, tiers, extrait,
              valide_par_user, rang, note_utilisateur, created_at
       FROM bahyo_portfolio_bs_extrait
       WHERE portfolio_id = $1
       ORDER BY
         array_position(ARRAY['verifiee','potentielle','detaillee','candidat']::text[], force::text),
         created_at`,
      [portfolio[0].id]
    );

    const { rows: ecartes } = await query(
      `SELECT id, ref_locale, aptitude, acte, verdict, raison, extrait, created_at
       FROM bahyo_portfolio_ecarte
       WHERE portfolio_id = $1
       ORDER BY created_at`,
      [portfolio[0].id]
    );

    const { rows: blocs } = await query(
      `SELECT id, portfolio_bs_id, titre_public, description_publique,
              type, prix_indicatif_eur, hash_contenu, nom_fichier_original,
              taille_octets, ordre, created_at
       FROM bahyo_bloc_etendu
       WHERE user_id = $1
       ORDER BY portfolio_bs_id, ordre`,
      [userId]
    );

    const { rows: sources } = await query(
      `SELECT id, type, nom_fichier, taille_octets, est_reference,
              poids_reference, created_at
       FROM bahyo_source
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    const bioskills = retenus.map(bs => ({
      ...bs,
      source_nom: null, // TODO : ajouter source_id sur bahyo_portfolio_bs_extrait
      blocs_etendus: blocs.filter(b => b.portfolio_bs_id === bs.id),
    }));

    res.json({
      portfolio: portfolio[0],
      provenance: {
        segmentation:  portfolio[0].provenance_segmentation,
        definition:    portfolio[0].provenance_definition,
        qualification: portfolio[0].provenance_qualification,
      },
      contrat_version: portfolio[0].contrat_version,
      bioskills,
      ecartes,
      sources,
    });
  } catch (err) {
    console.error('[PORTFOLIO] Erreur get:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /portfolio/analyze ──────────────────────────────────────────────────
router.post('/analyze', requireAuth, async (req, res) => {
  try {
    const { texte, source_ids, source_resume } = req.body;
    const userId = req.user.id;

    let corpus = (texte || '').trim();
    if (source_ids?.length > 0) {
      const { rows } = await query(
        `SELECT contenu_texte FROM bahyo_source
         WHERE id = ANY($1) AND user_id = $2`,
        [source_ids, userId]
      );
      corpus = [corpus, ...rows.map(r => r.contenu_texte)].filter(Boolean).join('\n\n');
    }

    if (corpus.length < 20) {
      return res.status(400).json({ error: 'Texte trop court (minimum 20 caracteres)' });
    }

    let moteur;
    try {
      const r = await fetch(`${EXTRACTION_URL}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texte: corpus, source_resume: source_resume || null }),
      });
      if (!r.ok) {
        const detail = await r.text();
        console.error('[PORTFOLIO] Moteur HTTP', r.status, detail);
        return res.status(502).json({ error: "Le moteur d'extraction a renvoye une erreur" });
      }
      moteur = await r.json();
    } catch (e) {
      console.error('[PORTFOLIO] Moteur injoignable:', e.message);
      return res.status(503).json({ error: "Moteur d'extraction injoignable" });
    }

    const pb = moteur?.portfolio_brut;
    if (!pb || !Array.isArray(pb.retenus) || !Array.isArray(pb.ecartes)) {
      return res.status(502).json({ error: 'Reponse moteur non conforme (portfolio_brut absent)' });
    }

    const { rows: pf } = await query(
      'SELECT id FROM bahyo_portfolio_user WHERE user_id = $1',
      [userId]
    );
    if (!pf[0]) return res.status(404).json({ error: 'Portefeuille introuvable' });
    const portfolioId = pf[0].id;

    await withTransaction(async (client) => {
      await client.query(
        `DELETE FROM bahyo_portfolio_bs_extrait
         WHERE portfolio_id = $1 AND valide_par_user = FALSE`,
        [portfolioId]
      );
      await client.query(
        'DELETE FROM bahyo_portfolio_ecarte WHERE portfolio_id = $1',
        [portfolioId]
      );

      for (const bs of pb.retenus) {
        const force = normaliserForce(bs.force);
        await client.query(
          `INSERT INTO bahyo_portfolio_bs_extrait
             (portfolio_id, ref_locale, aptitude, acte, verdict, force, tiers, extrait, embedding)
           VALUES ($1,$2,$3,$4,'competence',$5,$6,$7,$8)
           ON CONFLICT (portfolio_id, ref_locale) DO UPDATE SET
             aptitude = EXCLUDED.aptitude,
             acte     = EXCLUDED.acte,
             force    = EXCLUDED.force,
             tiers    = EXCLUDED.tiers,
             extrait  = EXCLUDED.extrait,
             updated_at = NOW()`,
          [
            portfolioId, bs.id, bs.aptitude, bs.acte ?? null,
            force, bs.tiers ?? null, bs.extrait ?? null,
            bs.embedding ?? null,
          ]
        );
      }

      for (const ec of pb.ecartes) {
        await client.query(
          `INSERT INTO bahyo_portfolio_ecarte
             (portfolio_id, ref_locale, aptitude, acte, verdict, raison, extrait)
           VALUES ($1,$2,$3,$4,'rejet',$5,$6)
           ON CONFLICT (portfolio_id, ref_locale) DO NOTHING`,
          [portfolioId, ec.id, ec.aptitude, ec.acte ?? null, ec.raison, ec.extrait ?? null]
        );
      }

      await client.query(
        `UPDATE bahyo_portfolio_user SET
           contrat_version          = $1,
           provenance_segmentation  = $2,
           provenance_definition    = $3,
           provenance_qualification = $4,
           source_resume            = $5,
           extraction_at            = NOW(),
           statut = CASE WHEN statut = 'BROUILLON' THEN 'CONSTITUE' ELSE statut END,
           updated_at = NOW()
         WHERE id = $6`,
        [
          pb.contrat_version ?? null,
          pb.provenance?.segmentation ?? null,
          pb.provenance?.definition ?? null,
          pb.provenance?.qualification ?? null,
          pb.source_resume ?? null,
          portfolioId,
        ]
      );
    });

    res.json({
      portfolio_brut: {
        ...pb,
        retenus: pb.retenus.map(bs => ({ ...bs, force: normaliserForce(bs.force) })),
      },
    });
  } catch (err) {
    console.error('[PORTFOLIO] Erreur analyze:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PUT /portfolio/bioskills/:id ────────────────────────────────────────────
router.put('/bioskills/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { rang = 'PRIMAIRE', note_utilisateur, action = 'VALIDER' } = req.body;

    const { rows: check } = await query(
      `SELECT e.id FROM bahyo_portfolio_bs_extrait e
       JOIN bahyo_portfolio_user p ON p.id = e.portfolio_id
       WHERE e.id = $1 AND p.user_id = $2`,
      [id, userId]
    );
    if (!check[0]) return res.status(404).json({ error: 'BioSkill introuvable' });

    if (action === 'REJETER') {
      await query(
        `UPDATE bahyo_portfolio_bs_extrait
         SET valide_par_user = FALSE, rang = NULL, updated_at = NOW()
         WHERE id = $1`,
        [id]
      );
      return res.json({ message: 'BioSkill retire du portefeuille' });
    }

    const { rows } = await query(
      `UPDATE bahyo_portfolio_bs_extrait
       SET valide_par_user = TRUE,
           rang = $2,
           note_utilisateur = COALESCE($3, note_utilisateur),
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, aptitude, force, tiers, extrait, rang, valide_par_user`,
      [id, rang, note_utilisateur ?? null]
    );

    await query(
      `UPDATE bahyo_portfolio_user SET statut = 'CONSTITUE', updated_at = NOW()
       WHERE user_id = $1 AND statut = 'BROUILLON'`,
      [userId]
    );

    res.json({ message: 'BioSkill valide', bioskill: rows[0] });
  } catch (err) {
    console.error('[PORTFOLIO] Erreur update BS:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /portfolio/bs/manuel ────────────────────────────────────────────────
// Cree un BS extrait manuellement par l'utilisateur + blocs etendus optionnels.
router.post('/bs/manuel', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      aptitude, acte, force = 'candidat', tiers, extrait,
      rang = 'PRIMAIRE', note_utilisateur, blocs_etendus = [],
    } = req.body;

    if (!aptitude || aptitude.trim().length < 3) {
      return res.status(400).json({ error: 'Aptitude requise (min 3 caracteres)' });
    }

    const { rows: pf } = await query(
      'SELECT id FROM bahyo_portfolio_user WHERE user_id = $1', [userId]
    );
    if (!pf[0]) return res.status(404).json({ error: 'Portefeuille introuvable' });
    const portfolioId = pf[0].id;

    const refLocale = `MAN-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    const forceValide = ['verifiee', 'potentielle', 'detaillee', 'candidat'].includes(force)
      ? force : 'candidat';

    const result = await withTransaction(async (client) => {
      const { rows: bsRows } = await client.query(
        `INSERT INTO bahyo_portfolio_bs_extrait
           (portfolio_id, ref_locale, aptitude, acte, verdict, force, tiers, extrait,
            valide_par_user, rang, note_utilisateur)
         VALUES ($1, $2, $3, $4, 'competence', $5, $6, $7, TRUE, $8, $9)
         RETURNING id, ref_locale, aptitude, acte, force, tiers, extrait,
                   valide_par_user, rang, note_utilisateur, created_at`,
        [portfolioId, refLocale, aptitude.trim(), acte || null,
         forceValide, tiers || null, extrait || null,
         rang, note_utilisateur || null]
      );
      const bs = bsRows[0];

      const blocsInseres = [];
      for (let i = 0; i < blocs_etendus.length; i++) {
        const b = blocs_etendus[i];
        if (!b.titre_public) continue;
        const { rows: blocRows } = await client.query(
          `INSERT INTO bahyo_bloc_etendu
             (portfolio_bs_id, user_id, titre_public, description_publique, type,
              prix_indicatif_eur, contenu_chiffre, iv_chiffrement, hash_contenu,
              nom_fichier_original, taille_octets, ordre)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id, titre_public, description_publique, type, ordre`,
          [
            bs.id, userId, b.titre_public, b.description_publique || null,
            b.type || 'AUTRE', b.prix_indicatif_eur || null,
            b.contenu_chiffre ? Buffer.from(b.contenu_chiffre, 'base64') : null,
            b.iv_chiffrement   ? Buffer.from(b.iv_chiffrement,   'base64') : null,
            b.hash_contenu || null, b.nom_fichier_original || null,
            b.taille_octets || null, i,
          ]
        );
        blocsInseres.push(blocRows[0]);
      }

      await client.query(
        `UPDATE bahyo_portfolio_user SET statut = 'CONSTITUE', updated_at = NOW()
         WHERE id = $1 AND statut = 'BROUILLON'`, [portfolioId]
      );

      return { bs, blocs: blocsInseres };
    });

    await auditLog(userId, 'BS_MANUEL_CREE', 'bs_extrait', result.bs.id,
                   { aptitude, force: forceValide, nb_blocs: result.blocs.length }, req);

    res.status(201).json({
      message: 'BS enregistre', bs: result.bs, blocs_etendus: result.blocs,
    });
  } catch (err) {
    console.error('[PORTFOLIO] Erreur BS manuel:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /portfolio/blocs-etendus ────────────────────────────────────────────
router.post('/blocs-etendus', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const {
      portfolio_bs_id, titre_public, description_publique, type = 'AUTRE',
      prix_indicatif_eur, contenu_chiffre, iv_chiffrement, hash_contenu,
      nom_fichier_original, taille_octets, ordre = 0,
    } = req.body;

    if (!titre_public || !portfolio_bs_id) {
      return res.status(400).json({ error: 'titre_public et portfolio_bs_id requis' });
    }

    const { rows: check } = await query(
      `SELECT e.id FROM bahyo_portfolio_bs_extrait e
       JOIN bahyo_portfolio_user p ON p.id = e.portfolio_id
       WHERE e.id = $1 AND p.user_id = $2`,
      [portfolio_bs_id, userId]
    );
    if (!check[0]) return res.status(403).json({ error: 'Acces non autorise a ce BioSkill' });

    const { rows } = await query(
      `INSERT INTO bahyo_bloc_etendu
         (portfolio_bs_id, user_id, titre_public, description_publique, type,
          prix_indicatif_eur, contenu_chiffre, iv_chiffrement, hash_contenu,
          nom_fichier_original, taille_octets, ordre)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, titre_public, description_publique, type,
                 prix_indicatif_eur, hash_contenu, created_at`,
      [
        portfolio_bs_id, userId, titre_public, description_publique, type,
        prix_indicatif_eur, contenu_chiffre, iv_chiffrement, hash_contenu,
        nom_fichier_original, taille_octets, ordre,
      ]
    );

    res.status(201).json({ message: 'Bloc etendu ajoute', bloc: rows[0] });
  } catch (err) {
    console.error('[PORTFOLIO] Erreur bloc etendu:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;