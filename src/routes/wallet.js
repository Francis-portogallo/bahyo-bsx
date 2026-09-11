// src/routes/wallet.js
// @version 1.0.0
// @date    2026-09-11
// @change  1.0.0 — Economie Talent : solde, historique, credit initial,
//                  gain BS valide, cout actions BScraft/Antichambre.
// ============================================================================
import { Router } from 'express';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// ── Helpers ──────────────────────────────────────────────────────────────────
async function getConfig(cle, defaut) {
  const { rows } = await query('SELECT valeur FROM bahyo_config WHERE cle = $1', [cle]);
  return rows[0] ? parseInt(rows[0].valeur, 10) : defaut;
}

async function getSolde(userId) {
  const { rows } = await query('SELECT solde FROM bahyo_token_wallet WHERE user_id = $1', [userId]);
  return rows[0]?.solde ?? 0;
}

// Debite/credite le wallet + enregistre le mouvement. Retourne le nouveau solde.
export async function mouvementTalent(userId, type, montant, description, referenceId = null) {
  return withTransaction(async (client) => {
    // Assurer l'existence du wallet
    await client.query(
      `INSERT INTO bahyo_token_wallet (user_id, solde, total_gagne, total_depense)
       VALUES ($1, 0, 0, 0) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    const { rows: cur } = await client.query(
      'SELECT solde FROM bahyo_token_wallet WHERE user_id = $1 FOR UPDATE',
      [userId]
    );
    const solde = cur[0].solde;
    const nouveauSolde = solde + montant;
    if (nouveauSolde < 0) {
      throw new Error(`Solde Talent insuffisant (${solde}, requis ${-montant})`);
    }
    await client.query(
      `UPDATE bahyo_token_wallet
       SET solde = $1,
           total_gagne   = total_gagne   + GREATEST(0, $2),
           total_depense = total_depense + GREATEST(0, -$2),
           updated_at = NOW()
       WHERE user_id = $3`,
      [nouveauSolde, montant, userId]
    );
    await client.query(
      `INSERT INTO bahyo_talent_mouvement
         (user_id, type, montant, solde_apres, reference_id, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, type, montant, nouveauSolde, referenceId, description]
    );
    return nouveauSolde;
  });
}

// ── GET /wallet ──────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT solde, total_gagne, total_depense, updated_at
       FROM bahyo_token_wallet WHERE user_id = $1`,
      [req.user.id]
    );
    const w = rows[0] || { solde: 0, total_gagne: 0, total_depense: 0 };
    res.json({ wallet: w });
  } catch (err) {
    console.error('[WALLET] Erreur get:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /wallet/mouvements ───────────────────────────────────────────────────
router.get('/mouvements', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, type, montant, solde_apres, description, created_at
       FROM bahyo_talent_mouvement
       WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ mouvements: rows });
  } catch (err) {
    console.error('[WALLET] Erreur mouvements:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /wallet/credit-initial (une seule fois par user) ────────────────────
router.post('/credit-initial', async (req, res) => {
  try {
    const userId = req.user.id;
    // Verifier si le credit initial a deja ete verse
    const { rows } = await query(
      `SELECT 1 FROM bahyo_talent_mouvement
       WHERE user_id = $1 AND type = 'CREDIT_INITIAL' LIMIT 1`,
      [userId]
    );
    if (rows[0]) return res.status(409).json({ error: 'Credit initial deja verse' });

    const montant = await getConfig('talent_credit_initial', 200);
    const solde = await mouvementTalent(
      userId, 'CREDIT_INITIAL', montant, `Credit d'accueil Bahyo (${montant} Talent)`
    );
    res.json({ solde, credite: montant });
  } catch (err) {
    console.error('[WALLET] Erreur credit initial:', err.message);
    res.status(500).json({ error: err.message || 'Erreur serveur' });
  }
});

// ── POST /wallet/spend { type, reference_id?, description? } ─────────────────
// Actions autorisees et cout depuis bahyo_config.
const ACTIONS_COUT = {
  BSCRAFT_A3:          'talent_cout_bscraft_a3',
  BSCRAFT_REFORMUL:    'talent_cout_bscraft_reformuler',
  BSCRAFT_ATTESTATION: 'talent_cout_bscraft_attestation',
  ANTICHAMBRE_COMPAR:  'talent_cout_antichambre_compar',
  ANTICHAMBRE_SIMUL:   'talent_cout_antichambre_simul',
  ANTICHAMBRE_OPTIM:   'talent_cout_antichambre_optim',
};

router.post('/spend', async (req, res) => {
  try {
    const { type, reference_id, description } = req.body;
    const cleConfig = ACTIONS_COUT[type];
    if (!cleConfig) return res.status(400).json({ error: 'Type d\'action invalide' });

    const cout = await getConfig(cleConfig, 10);
    const label = {
      BSCRAFT_A3:          'BScraft : renforcement A3 (attestation)',
      BSCRAFT_REFORMUL:    'BScraft : reformulation acte',
      BSCRAFT_ATTESTATION: 'BScraft : recherche d\'attestation',
      ANTICHAMBRE_COMPAR:  'Antichambre : analyse de comparables',
      ANTICHAMBRE_SIMUL:   'Antichambre : simulation de marche',
      ANTICHAMBRE_OPTIM:   'Antichambre : optimisation de la cote globale',
    }[type];

    const solde = await mouvementTalent(
      req.user.id, `COUT_${type}`, -cout,
      description || label, reference_id || null
    );
    res.json({ solde, debite: cout, action: type });
  } catch (err) {
    if (err.message?.includes('insuffisant')) {
      return res.status(402).json({ error: err.message, code: 'INSUFFICIENT_TALENT' });
    }
    console.error('[WALLET] Erreur spend:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /wallet/bareme ───────────────────────────────────────────────────────
router.get('/bareme', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT cle, valeur FROM bahyo_config WHERE cle LIKE 'talent_%'`
    );
    const bareme = {};
    rows.forEach(r => { bareme[r.cle] = parseInt(r.valeur, 10); });
    res.json({ bareme });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;
