// src/routes/admin.js
// @version 1.3.0
// @date    2026-08-27
// @change  1.3.0 — Motifs normalises pour suspension/fermeture (dropdown ferme)
//                  + code obligatoire + details libres. Sur fermeture, l'email
//                  est renomme (+closed_TS) pour liberer l'original.
//                  Route GET /reasons expose les listes de motifs pour le front.
//          1.2.0 — Gestion des comptes existants : GET /users (avec filtres),
//                  POST /users/:id/suspend, POST /users/:id/reactivate,
//                  POST /users/:id/close (soft delete), POST /users/:id/force-nda-resign.
//                  /approve REFUSE si nda_signed_at IS NULL.
//          1.1.0 — NDA multilingue (FR + EN) : routes /nda acceptent ?lang=
//                  et publient une version par langue.
//          1.0.0 — Routes admin protegees par middleware requireSuperadmin :
//                  - Whitelist emails (list / add / remove)
//                  - NDA (voir version courante, historique, publier nouvelle)
//                  - Comptes en attente d'approbation (list / approuver / rejeter)
// ============================================================================
import { Router } from 'express';
import crypto     from 'crypto';
import { query }  from '../db/pool.js';
import { requireAuth, auditLog } from '../middleware/auth.js';

const router = Router();

// ── Listes de motifs normalises ──────────────────────────────────────────────
const SUSPENSION_REASONS = [
  { code: 'NON_RESPECT_NDA',      label: 'Non respect de l\'accord de confidentialite' },
  { code: 'ABUS_PLATEFORME',      label: 'Abus de la plateforme' },
  { code: 'CONTENU_INAPPROPRIE',  label: 'Contenu inapproprie ou trompeur' },
  { code: 'ATTEINTE_A_AUTRUI',    label: 'Atteinte a d\'autres utilisateurs' },
  { code: 'ENQUETE_EN_COURS',     label: 'Enquete en cours' },
  { code: 'DEMANDE_UTILISATEUR',  label: 'Demande de l\'utilisateur' },
  { code: 'AUTRE',                label: 'Autre (details obligatoires)' },
];

const CLOSURE_REASONS = [
  { code: 'DEMANDE_UTILISATEUR',   label: 'Demande de l\'utilisateur (RGPD)' },
  { code: 'NON_RESPECT_NDA',       label: 'Non respect grave de l\'accord de confidentialite' },
  { code: 'FRAUDE',                label: 'Fraude averee' },
  { code: 'USAGE_MALVEILLANT',     label: 'Usage malveillant de la plateforme' },
  { code: 'INACTIVITE_PROLONGEE',  label: 'Inactivite prolongee (>24 mois)' },
  { code: 'DOUBLE_COMPTE',         label: 'Doublon de compte' },
  { code: 'AUTRE',                 label: 'Autre (details obligatoires)' },
];

// ── GET /admin/reasons ───────────────────────────────────────────────────────
router.get('/reasons', (req, res) => {
  res.json({ suspension: SUSPENSION_REASONS, closure: CLOSURE_REASONS });
});

// ── Middleware requireSuperadmin ─────────────────────────────────────────────
async function requireSuperadmin(req, res, next) {
  try {
    const { rows } = await query(
      'SELECT is_superadmin FROM bahyo_user WHERE id = $1', [req.user.id]
    );
    if (!rows[0]?.is_superadmin) {
      return res.status(403).json({ error: 'Acces reserve au superadmin' });
    }
    next();
  } catch (err) {
    console.error('[ADMIN] Erreur superadmin check:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
}

router.use(requireAuth, requireSuperadmin);

// ═══════════════════════════════════════════════════════════════════════════
//  WHITELIST
// ═══════════════════════════════════════════════════════════════════════════

router.get('/whitelist', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, email, motif, ajoute_par, created_at FROM bahyo_whitelist_email ORDER BY created_at DESC'
    );
    res.json({ whitelist: rows });
  } catch (err) {
    console.error('[ADMIN] Erreur whitelist list:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/whitelist', async (req, res) => {
  try {
    const { email, motif } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email invalide' });
    }
    const { rows } = await query(
      `INSERT INTO bahyo_whitelist_email (email, motif, ajoute_par)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id, email, motif, created_at`,
      [email.toLowerCase(), motif || null, req.user.email || 'superadmin']
    );
    if (!rows[0]) return res.status(409).json({ error: 'Email deja dans la whitelist' });

    await auditLog(req.user.id, 'WHITELIST_ADD', 'whitelist', rows[0].id, { email, motif }, req);
    res.status(201).json({ message: 'Ajoute a la whitelist', entry: rows[0] });
  } catch (err) {
    console.error('[ADMIN] Erreur whitelist add:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/whitelist/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'DELETE FROM bahyo_whitelist_email WHERE id = $1 RETURNING email',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Entree introuvable' });

    await auditLog(req.user.id, 'WHITELIST_REMOVE', 'whitelist', req.params.id,
                   { email: rows[0].email }, req);
    res.json({ message: 'Retire de la whitelist' });
  } catch (err) {
    console.error('[ADMIN] Erreur whitelist delete:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  NDA
// ═══════════════════════════════════════════════════════════════════════════

// Version courante active pour une langue donnee (?lang=fr|en)
router.get('/nda/current', async (req, res) => {
  try {
    const lang = (req.query.lang || 'fr').toLowerCase();
    const { rows } = await query(
      'SELECT id, version, lang, texte, created_at, created_by FROM bahyo_nda WHERE actif = TRUE AND lang = $1 LIMIT 1',
      [lang]
    );
    res.json({ nda: rows[0] || null });
  } catch (err) {
    console.error('[ADMIN] Erreur NDA current:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Historique complet (toutes langues)
router.get('/nda/history', async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT id, version, lang, actif, created_at, created_by FROM bahyo_nda ORDER BY created_at DESC'
    );
    res.json({ history: rows });
  } catch (err) {
    console.error('[ADMIN] Erreur NDA history:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Publier une nouvelle version pour une langue : rend l'ancienne (meme lang) inactive
router.post('/nda', async (req, res) => {
  try {
    const { version, texte, lang } = req.body;
    const langNorm = (lang || 'fr').toLowerCase();
    if (!['fr', 'en'].includes(langNorm)) {
      return res.status(400).json({ error: 'Langue invalide (fr ou en)' });
    }
    if (!version || !texte || texte.length < 100) {
      return res.status(400).json({ error: 'Version + texte (min 100 caracteres) requis' });
    }
    // Desactiver l'ancienne version active de cette langue
    await query('UPDATE bahyo_nda SET actif = FALSE WHERE actif = TRUE AND lang = $1', [langNorm]);
    const { rows } = await query(
      `INSERT INTO bahyo_nda (version, lang, texte, actif, created_by)
       VALUES ($1, $2, $3, TRUE, $4)
       ON CONFLICT (version, lang) DO UPDATE SET actif = TRUE, texte = EXCLUDED.texte
       RETURNING id, version, lang, created_at`,
      [version, langNorm, texte, req.user.email || 'superadmin']
    );
    await auditLog(req.user.id, 'NDA_PUBLIE', 'nda', rows[0].id, { version, lang: langNorm }, req);
    res.status(201).json({ message: `Nouvelle version NDA (${langNorm}) publiee`, nda: rows[0] });
  } catch (err) {
    console.error('[ADMIN] Erreur NDA publier:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  COMPTES EN ATTENTE D'APPROBATION
// ═══════════════════════════════════════════════════════════════════════════

router.get('/pending', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, email, display_name, ln_url, created_at,
              nda_signed_at, nda_version, nda_ip
       FROM bahyo_user
       WHERE email_verified = TRUE AND account_approved = FALSE
       ORDER BY created_at DESC`
    );
    res.json({ pending: rows });
  } catch (err) {
    console.error('[ADMIN] Erreur pending list:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/approve/:id', async (req, res) => {
  try {
    // Verifier la signature NDA AVANT d'approuver (condition sine qua non)
    const { rows: check } = await query(
      'SELECT email, nda_signed_at FROM bahyo_user WHERE id = $1',
      [req.params.id]
    );
    if (!check[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (!check[0].nda_signed_at) {
      return res.status(400).json({
        error: `Impossible d'approuver : ${check[0].email} n'a pas signe l'accord de confidentialite.`,
        code: 'NDA_NOT_SIGNED',
      });
    }

    const { rows } = await query(
      `UPDATE bahyo_user
       SET account_approved = TRUE, approved_at = NOW(), approved_by = $2
       WHERE id = $1 AND account_approved = FALSE
       RETURNING email, display_name`,
      [req.params.id, req.user.email || 'superadmin']
    );
    if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable ou deja approuve' });

    await auditLog(req.user.id, 'COMPTE_APPROUVE', 'user', req.params.id, { email: rows[0].email }, req);
    res.json({ message: `Compte ${rows[0].email} approuve` });
  } catch (err) {
    console.error('[ADMIN] Erreur approve:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.delete('/reject/:id', async (req, res) => {
  try {
    const { rows } = await query(
      'DELETE FROM bahyo_user WHERE id = $1 AND account_approved = FALSE RETURNING email',
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable ou deja approuve' });

    await auditLog(req.user.id, 'COMPTE_REJETE', 'user', req.params.id, { email: rows[0].email }, req);
    res.json({ message: `Compte ${rows[0].email} rejete et supprime` });
  } catch (err) {
    console.error('[ADMIN] Erreur reject:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GESTION DES COMPTES EXISTANTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/users — liste tous les comptes avec filtres optionnels
// query : ?statut=all|actif|suspendu|ferme|en_attente (defaut all)
router.get('/users', async (req, res) => {
  try {
    const statut = req.query.statut || 'all';
    let where = '1=1';
    if (statut === 'actif')      where = 'account_approved = TRUE AND suspended_at IS NULL AND closed_at IS NULL';
    else if (statut === 'suspendu')   where = 'suspended_at IS NOT NULL AND closed_at IS NULL';
    else if (statut === 'ferme')      where = 'closed_at IS NOT NULL';
    else if (statut === 'en_attente') where = 'account_approved = FALSE AND closed_at IS NULL';

    const { rows } = await query(
      `SELECT id, email, display_name, ln_url, created_at,
              email_verified, account_approved, is_superadmin,
              nda_signed_at, nda_version, force_nda_resign,
              suspended_at, suspended_reason,
              closed_at, closed_reason,
              last_login_at
       FROM bahyo_user
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT 200`
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('[ADMIN] Erreur users list:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /admin/users/:id/suspend { reason_code, reason_details? }
router.post('/users/:id/suspend', async (req, res) => {
  try {
    const { reason_code, reason_details } = req.body;
    const codeOk = SUSPENSION_REASONS.some(r => r.code === reason_code);
    if (!codeOk) return res.status(400).json({ error: 'Motif (code) invalide' });
    if (reason_code === 'AUTRE' && (!reason_details || reason_details.trim().length < 10)) {
      return res.status(400).json({ error: 'Details requis (min 10 caracteres) pour le motif Autre' });
    }
    const { rows: chk } = await query('SELECT email, is_superadmin FROM bahyo_user WHERE id = $1', [req.params.id]);
    if (!chk[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (chk[0].is_superadmin) return res.status(403).json({ error: 'Impossible de suspendre un superadmin' });

    const label = SUSPENSION_REASONS.find(r => r.code === reason_code).label;
    const raisonTexte = reason_details?.trim() ? `${label} — ${reason_details.trim()}` : label;

    await query(
      `UPDATE bahyo_user
       SET suspended_at = NOW(), suspended_by = $2,
           suspended_reason_code = $3, suspended_reason = $4
       WHERE id = $1`,
      [req.params.id, req.user.email || 'superadmin', reason_code, raisonTexte]
    );
    await query('DELETE FROM bahyo_user_session WHERE user_id = $1', [req.params.id]);

    await auditLog(req.user.id, 'COMPTE_SUSPENDU', 'user', req.params.id,
                   { email: chk[0].email, reason_code, reason_details }, req);
    res.json({ message: `Compte ${chk[0].email} suspendu` });
  } catch (err) {
    console.error('[ADMIN] Erreur suspend:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /admin/users/:id/reactivate
router.post('/users/:id/reactivate', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE bahyo_user
       SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL,
           login_attempts = 0, locked_until = NULL
       WHERE id = $1 AND suspended_at IS NOT NULL AND closed_at IS NULL
       RETURNING email`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Utilisateur non suspendu ou introuvable' });

    await auditLog(req.user.id, 'COMPTE_REACTIVE', 'user', req.params.id, { email: rows[0].email }, req);
    res.json({ message: `Compte ${rows[0].email} reactive` });
  } catch (err) {
    console.error('[ADMIN] Erreur reactivate:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /admin/users/:id/close { reason_code, reason_details? }
// Soft delete + renomme l'email (+closed_TS) pour liberer l'original.
router.post('/users/:id/close', async (req, res) => {
  try {
    const { reason_code, reason_details } = req.body;
    const codeOk = CLOSURE_REASONS.some(r => r.code === reason_code);
    if (!codeOk) return res.status(400).json({ error: 'Motif (code) invalide' });
    if (reason_code === 'AUTRE' && (!reason_details || reason_details.trim().length < 10)) {
      return res.status(400).json({ error: 'Details requis (min 10 caracteres) pour le motif Autre' });
    }
    const { rows: chk } = await query('SELECT email, is_superadmin FROM bahyo_user WHERE id = $1', [req.params.id]);
    if (!chk[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });
    if (chk[0].is_superadmin) return res.status(403).json({ error: 'Impossible de fermer un superadmin' });

    const label = CLOSURE_REASONS.find(r => r.code === reason_code).label;
    const raisonTexte = reason_details?.trim() ? `${label} — ${reason_details.trim()}` : label;

    // Renommer l'email pour liberer l'original : ex "alice@x.com" -> "alice+closed_1735291020@x.com"
    const originalEmail = chk[0].email;
    const at    = originalEmail.indexOf('@');
    const local = originalEmail.slice(0, at);
    const dom   = originalEmail.slice(at);
    const closedEmail = `${local}+closed_${Date.now()}${dom}`;

    await query(
      `UPDATE bahyo_user
       SET closed_at = NOW(), closed_by = $2,
           closed_reason_code = $3, closed_reason = $4,
           closed_original_email = $5,
           email = $6,
           account_approved = FALSE, email_verified = FALSE
       WHERE id = $1`,
      [req.params.id, req.user.email || 'superadmin',
       reason_code, raisonTexte, originalEmail, closedEmail]
    );
    await query('DELETE FROM bahyo_user_session WHERE user_id = $1', [req.params.id]);

    await auditLog(req.user.id, 'COMPTE_FERME', 'user', req.params.id,
                   { email: originalEmail, reason_code, reason_details }, req);
    res.json({
      message: `Compte ${originalEmail} ferme. L'email est libere et peut etre reutilise pour une nouvelle inscription.`,
    });
  } catch (err) {
    console.error('[ADMIN] Erreur close:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /admin/users/:id/force-nda-resign — obligera l'user a re-signer au prochain login
router.post('/users/:id/force-nda-resign', async (req, res) => {
  try {
    const { rows } = await query(
      `UPDATE bahyo_user SET force_nda_resign = TRUE WHERE id = $1 RETURNING email`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });

    await auditLog(req.user.id, 'FORCE_NDA_RESIGN', 'user', req.params.id, { email: rows[0].email }, req);
    res.json({ message: `${rows[0].email} devra re-signer le NDA au prochain login` });
  } catch (err) {
    console.error('[ADMIN] Erreur force-nda-resign:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  STATISTIQUES
// ═══════════════════════════════════════════════════════════════════════════

router.get('/stats', async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*) FROM bahyo_user)                                             AS total_users,
        (SELECT COUNT(*) FROM bahyo_user WHERE account_approved = TRUE)              AS approuves,
        (SELECT COUNT(*) FROM bahyo_user WHERE account_approved = FALSE AND email_verified = TRUE) AS en_attente,
        (SELECT COUNT(*) FROM bahyo_user WHERE email_verified = FALSE)               AS non_verifies,
        (SELECT COUNT(*) FROM bahyo_whitelist_email)                                 AS whitelist_count,
        (SELECT COUNT(*) FROM bahyo_portfolio_bs_extrait WHERE valide_par_user = TRUE) AS bs_valides
    `);
    res.json({ stats: rows[0] });
  } catch (err) {
    console.error('[ADMIN] Erreur stats:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;