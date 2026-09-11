// src/routes/ia.js
// @version 1.1.0
// @date    2026-08-24
// @change  1.1.0 — Étage 1 : system prompt force/tiers/extrait, chargerContexte() factorisé,
//                  requête sur bahyo_portfolio_bs_extrait (suppression similarite/M4/Diday)
//          1.0.0 — Version initiale BFF Bahyo (moteur Diday, bahyo_portfolio_bs, 4P)
// ============================================================================
// Étage 1 — Assistant IA (moteur d'extraction sémique-déductive)
// ----------------------------------------------------------------------------
// Trois changements par rapport à l'ancienne version Diday :
//   1. System prompt : modèle force/tiers/extrait au lieu de 4P PRODUIT/PLACE/PROMOTION.
//   2. Requête de contexte (/session) : lit bahyo_portfolio_bs_extrait.
//   3. Requête de contexte (/message) : idem, avec similarite supprimée.
// Le reste (tarifs, débit BAH, historique, wallet) est inchangé.
// ============================================================================
import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, auditLog } from '../middleware/auth.js';

const router = Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Tarifs en tokens BAH (chargés depuis la config)
async function getTarifs() {
  const { rows } = await query(
    `SELECT cle, valeur FROM bahyo_config WHERE cle LIKE 'ia_tarif_%'`
  );
  return Object.fromEntries(rows.map(r => [r.cle, parseInt(r.valeur)]));
}

// ── Requête de contexte portefeuille ─────────────────────────────────────────
// Lit la table d'extraction (Étage 1). Renvoie les BS retenus (tous, pas
// seulement les validés) afin que l'assistant puisse commenter le brut complet.
async function chargerContexte(userId) {
  const { rows } = await query(
    `SELECT p.score_qualite, p.statut, p.source_resume,
            COALESCE(
              json_agg(
                json_build_object(
                  'aptitude',    e.aptitude,
                  'acte',        e.acte,
                  'force',       e.force,
                  'tiers',       e.tiers,
                  'extrait',     e.extrait,
                  'valide',      e.valide_par_user
                ) ORDER BY
                  array_position(
                    ARRAY['verifiee','potentielle','detaillee','candidat']::text[],
                    e.force::text
                  )
              ) FILTER (WHERE e.id IS NOT NULL),
              '[]'
            ) AS bioskills
     FROM bahyo_portfolio_user p
     LEFT JOIN bahyo_portfolio_bs_extrait e ON e.portfolio_id = p.id
     WHERE p.user_id = $1
     GROUP BY p.id`,
    [userId]
  );
  return rows[0] || { bioskills: [] };
}

// ── Système prompt ────────────────────────────────────────────────────────────
function getSystemPrompt(mode, contexte) {
  const base = `Tu es l'assistant Bahyo, expert en valorisation des compétences professionnelles.
Tu aides les utilisateurs à construire et affiner leur portefeuille de BioSkills sur la Bourse Bahyo.

Modèle Bahyo — Étage 1 (extraction) :
- Un BioSkill (BS) = un savoir-faire d'EXÉCUTION extrait directement du texte de l'utilisateur.
  Exemples : "Configurer une PKI/IGC", "Migrer une infrastructure Lotus Domino", "Optimiser des index PostgreSQL".
  À ÉCARTER : fonctions managériales, enveloppes de mission (diriger, coordonner, piloter sans geste technique).
- Force d'un BS (du plus fort au plus faible) :
    • verifiee  — tiers nommé + attestation explicite dans le texte
    • potentielle — vraisemblable mais sans tiers identifiable
    • detaillee  — contexte riche (chiffres, périmètre) mais sans tiers
    • candidat   — mention sans ancrage (force normale à l'état brut)
- tiers    : l'organisation ou la personne qui atteste le BS dans le texte.
- extrait  : la phrase du profil qui ancre le BS (traçabilité).

Tu réponds TOUJOURS en français, de manière concise et actionnable.
Tu ne mentionnes jamais les détails techniques du moteur d'extraction.`;

  if (mode === 'CONSTITUTION') {
    return `${base}

Mode : CONSTITUTION (gratuit)
Tu aides l'utilisateur à comprendre les BioSkills extraits de ses textes.
Questions typiques : "Pourquoi ce BS a-t-il la force 'candidat' ?", "Comment passer à 'vérifiée' ?",
"Ce BS a-t-il été écarté à tort ?", "Quoi ajouter pour enrichir mon portefeuille ?"
Tu peux suggérer des informations complémentaires à fournir pour élever la force d'un BS.
Tu t'appuies sur les extraits et les tiers déjà identifiés.

Portefeuille brut de l'utilisateur :
${JSON.stringify(contexte, null, 2)}`;
  }

  return `${base}

Mode : OPTIMISATION (payant en tokens BAH)
Tu analyses le portefeuille extrait et proposes des améliorations concrètes.
Tu identifies : les BS à force faible qui pourraient monter (données manquantes ?),
les candidats écartés qui méritent d'être challengés, les tiers non nommés.
Tu es proactif, précis, et cites les extraits du profil pour étayer tes suggestions.

Portefeuille brut de l'utilisateur :
${JSON.stringify(contexte, null, 2)}`;
}

// Estimer le coût en tokens BAH selon la longueur de la réponse
function estimerCout(tokensInput, tokensOutput, tarifs) {
  const totalTokens = tokensInput + tokensOutput;
  if (totalTokens < 800) return tarifs['ia_tarif_question_simple'] || 1;
  if (totalTokens < 3000) return tarifs['ia_tarif_analyse_bs'] || 5;
  return tarifs['ia_tarif_reanalyse_complete'] || 20;
}

// ─── POST /ia/session ─────────────────────────────────────────────────────────
router.post('/session', requireAuth, async (req, res) => {
  try {
    const { mode = 'CONSTITUTION' } = req.body;
    const userId = req.user.id;

    if (mode === 'OPTIMISATION') {
      const { rows: wallet } = await query(
        'SELECT solde FROM bahyo_token_wallet WHERE user_id = $1',
        [userId]
      );
      if (!wallet[0] || wallet[0].solde < 1) {
        return res.status(402).json({
          error: 'Solde BAH insuffisant pour le mode optimisation',
          solde: wallet[0]?.solde || 0,
        });
      }
    }

    const contexte = await chargerContexte(userId);

    const { rows: session } = await query(
      `INSERT INTO bahyo_ia_session (user_id, portfolio_id, mode, messages)
       VALUES ($1, NULL, $2, '[]')
       RETURNING id`,
      [userId, mode]
    );

    res.status(201).json({
      session_id: session[0].id,
      mode,
      message_bienvenue: mode === 'CONSTITUTION'
        ? 'Bonjour ! Je suis votre assistant Bahyo. Je peux vous expliquer les BioSkills extraits de vos textes et vous aider à enrichir leur ancrage. Que souhaitez-vous savoir ?'
        : "Mode optimisation activé. J'analyse votre portefeuille pour identifier les BS à élever en force et les candidats à challenger. Par quoi voulez-vous commencer ?",
      contexte_charge: Array.isArray(contexte.bioskills) && contexte.bioskills.length > 0,
      system_prompt_mode: mode,
    });
  } catch (err) {
    console.error('[IA] Erreur création session:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── POST /ia/message ─────────────────────────────────────────────────────────
router.post('/message', requireAuth, async (req, res) => {
  try {
    const { session_id, message } = req.body;
    const userId = req.user.id;

    if (!session_id || !message) {
      return res.status(400).json({ error: 'session_id et message requis' });
    }

    const { rows: sessionRows } = await query(
      `SELECT * FROM bahyo_ia_session WHERE id = $1 AND user_id = $2`,
      [session_id, userId]
    );
    if (!sessionRows[0]) {
      return res.status(404).json({ error: 'Session introuvable' });
    }

    const session = sessionRows[0];
    const tarifs = await getTarifs();

    if (session.mode === 'OPTIMISATION') {
      const { rows: wallet } = await query(
        'SELECT solde FROM bahyo_token_wallet WHERE user_id = $1',
        [userId]
      );
      if (!wallet[0] || wallet[0].solde < 1) {
        return res.status(402).json({
          error: 'Solde BAH insuffisant',
          solde: wallet[0]?.solde || 0,
        });
      }
    }

    // Contexte frais à chaque message (le portefeuille peut avoir évolué)
    const contexte = await chargerContexte(userId);

    const historique = session.messages || [];
    const messages = [
      ...historique.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: message },
    ];

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20251001',
      max_tokens: 1024,
      system: getSystemPrompt(session.mode, contexte),
      messages,
    });

    const reponse = response.content[0].text;
    const tokensInput  = response.usage.input_tokens;
    const tokensOutput = response.usage.output_tokens;
    const coutBAH = session.mode === 'OPTIMISATION'
      ? estimerCout(tokensInput, tokensOutput, tarifs)
      : 0;

    const nouvelHistorique = [
      ...historique,
      { role: 'user',      content: message, ts: new Date().toISOString() },
      { role: 'assistant', content: reponse,  ts: new Date().toISOString() },
    ];

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE bahyo_ia_session SET
           messages           = $1,
           tokens_input       = tokens_input  + $2,
           tokens_output      = tokens_output + $3,
           tokens_bah_debites = tokens_bah_debites + $4,
           updated_at         = NOW()
         WHERE id = $5`,
        [JSON.stringify(nouvelHistorique), tokensInput, tokensOutput, coutBAH, session_id]
      );

      if (coutBAH > 0) {
        const { rows: wallet } = await client.query(
          'SELECT solde FROM bahyo_token_wallet WHERE user_id = $1',
          [userId]
        );
        await client.query(
          `INSERT INTO bahyo_token_transaction
             (user_id, type, montant, solde_apres, description, reference_id)
           VALUES ($1, 'IA_OPTIMISATION', $2, $3, $4, $5)`,
          [
            userId,
            -coutBAH,
            (wallet[0]?.solde || 0) - coutBAH,
            `Optimisation IA — ${tokensInput + tokensOutput} tokens Anthropic`,
            session_id,
          ]
        );
      }
    });

    res.json({
      reponse,
      session_id,
      tokens_bah_debites: coutBAH,
      mode: session.mode,
      usage: { input: tokensInput, output: tokensOutput },
    });
  } catch (err) {
    if (req.body?.session_id) {
      await query(
        `UPDATE bahyo_ia_session SET statut = 'ERREUR' WHERE id = $1`,
        [req.body.session_id]
      ).catch(() => {});
    }
    console.error('[IA] Erreur message:', err.message);
    res.status(500).json({ error: 'Erreur assistant IA. Réessayez.' });
  }
});

// ─── GET /ia/sessions ─────────────────────────────────────────────────────────
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, mode, tokens_bah_debites, statut, created_at, updated_at,
              json_array_length(messages) as nb_messages
       FROM bahyo_ia_session WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [req.user.id]
    );
    res.json({ sessions: rows });
  } catch (err) {
    console.error('[IA] Erreur sessions:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── GET /ia/wallet ───────────────────────────────────────────────────────────
router.get('/wallet', requireAuth, async (req, res) => {
  try {
    const { rows: wallet } = await query(
      `SELECT w.solde, w.total_gagne, w.total_depense,
              json_agg(json_build_object(
                'type',        t.type,
                'montant',     t.montant,
                'description', t.description,
                'created_at',  t.created_at
              ) ORDER BY t.created_at DESC) as historique
       FROM bahyo_token_wallet w
       LEFT JOIN bahyo_token_transaction t ON t.user_id = w.user_id
       WHERE w.user_id = $1
       GROUP BY w.solde, w.total_gagne, w.total_depense`,
      [req.user.id]
    );

    res.json(wallet[0] || { solde: 0, total_gagne: 0, total_depense: 0, historique: [] });
  } catch (err) {
    console.error('[IA] Erreur wallet:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;