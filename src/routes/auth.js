// src/routes/auth.js
// @version 1.7.1
// @date    2026-08-27
// @change  1.7.1 — Whitelist exemptee du NDA : au login, si force_nda_resign
//                  et email whitelist -> auto-signature marquee 'exempt-whitelist'
//                  et continuation normale.
//          1.7.0 — Comptes suspendus / fermes bloques au login (codes
//                  ACCOUNT_SUSPENDED / ACCOUNT_CLOSED). Legacy accounts
//                  sans NDA declenchent must_resign_nda au login + nouvelle
//                  route POST /auth/resign-nda.
//          1.6.2 — GET /auth/nda lit d'abord la version active en base
//                  (bahyo_nda.lang = $1 AND actif = TRUE) et retombe sur les
//                  constantes en fallback si absent.
//          1.6.1 — NDA disponible en FR et EN (constantes NDA_TEXT_FR /
//                  NDA_TEXT_EN + articles renforces). GET /auth/nda?lang=fr|en.
//          1.6.0 — Audit trail NDA (IP + user-agent + hash) + validation
//                  d'email au register (MX + blacklist des domaines jetables).
//                  Login retourne is_superadmin dans l'objet user.
//          1.5.0 — NDA obligatoire a l'inscription + whitelist emails :
//                  - Register accepte nda_accepted (obligatoire) et memorise
//                    nda_signed_at + nda_version dans bahyo_user
//                  - Nouvelle constante NDA_VERSION = '2026-08-27-v1'
//                  - Si l'email est dans bahyo_whitelist_email, le compte est
//                    automatiquement approuve (skip validation admin)
//                  - Nouvelle route GET /auth/nda pour recuperer le texte
//                    (frontend l'affiche + checkbox)
//          1.4.0 — Validation admin des comptes (approche A) :
//                  - Migration 005 : colonnes account_approved / approved_at / approved_by
//                  - /verify-email envoie mail admin avec liens Approuver/Rejeter (JWT 7j)
//                  - Login retourne 403 code=ACCOUNT_PENDING si non approuve
//                  - GET /auth/admin/approve?token=... et /auth/admin/reject?token=...
//                  - Notification user par mail apres decision admin
//                  Nouvelle env : ADMIN_EMAIL
//          1.3.0 — Mot de passe oublie : POST /auth/forgot-password (envoie mail)
//                  + POST /auth/reset-password (JWT scope=reset_password, 30 min)
//                  Reponse neutre a /forgot-password (ne revele pas si l'email existe)
//          1.2.1 — Fix nodemailer TLS (ignoreTLS port 25, rejectUnauthorized false)
//                  + fallback BFF_URL bsx.bahyo.net (etait bfx.bahyo.net)
//          1.2.0 — Securite : verification email a l'inscription (nodemailer),
//                  must_change_password au 1er login (change_token JWT 15 min),
//                  POST /auth/set-password, GET /auth/verify-email,
//                  POST /auth/resend-verification
//          1.1.0 — Etage 1 : ajout ln_url (register) + is_2017 (login) + migration 003
//          1.0.0 — Version initiale BFF Bahyo (JWT, bcrypt, 2FA speakeasy)
// Dependances ajoutees : nodemailer (npm install nodemailer)
// Migrations requises  : 003_ln_url.sql, 004_email_verification.sql
// Nouvelles variables  : SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS SMTP_FROM FRONTEND_URL
// ============================================================================
import { Router }    from 'express';
import bcrypt        from 'bcryptjs';
import speakeasy     from 'speakeasy';
import QRCode        from 'qrcode';
import jwt           from 'jsonwebtoken';
import nodemailer    from 'nodemailer';
import { randomBytes, createHash } from 'crypto';
import { promises as dns } from 'dns';
import { query, withTransaction } from '../db/pool.js';
import { generateTokens, auditLog } from '../middleware/auth.js';

// Domaines d'emails jetables les plus connus (a etendre au besoin)
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'yopmail.com', 'yopmail.fr', 'guerrillamail.com',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', '10minutemail.com',
  'trashmail.com', 'sharklasers.com', 'dispostable.com', 'maildrop.cc',
  'mintemail.com', 'mytemp.email', 'fakemail.net', 'getnada.com',
]);

// Verifie que le domaine a bien un enregistrement MX et n'est pas jetable
async function validerEmail(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return { ok: false, raison: 'Email invalide' };
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { ok: false, raison: 'Adresse email jetable non autorisee' };
  }
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx || mx.length === 0) {
      return { ok: false, raison: `Le domaine ${domain} n'accepte pas de mail (pas de MX)` };
    }
    return { ok: true };
  } catch (err) {
    // ENODATA = pas de MX, ENOTFOUND = domaine inexistant
    return { ok: false, raison: `Domaine ${domain} inexistant ou non joignable` };
  }
}

const router = Router();

// ── Constantes ────────────────────────────────────────────────────────────────
const SEUIL_2017          = new Date('2018-01-01T00:00:00Z');
const EMAIL_TOKEN_TTL_H   = 24;   // heures
const CHANGE_TOKEN_TTL    = '15m';
const RESET_TOKEN_TTL     = '30m';
const ADMIN_TOKEN_TTL     = '7d';
const NDA_VERSION         = '2026-08-27-v1';

// Texte de l'accord de confidentialite FR + EN (via GET /auth/nda?lang=fr|en)
const NDA_TEXT_FR = `ACCORD DE CONFIDENTIALITE — BAHYO

Entre :
- Bahyo, exploitant de la plateforme https://bsx.bahyo.net (ci-apres « Bahyo »)
- L'Utilisateur, personne physique ayant cree un compte sur la plateforme
  (ci-apres « l'Utilisateur »)

Preambule
La plateforme Bahyo permet a chaque Utilisateur de constituer, qualifier et
valoriser un portefeuille de BioSkills (BS) selon la methode 3A
(Aptitude - Acte - Attestation). Certaines informations echangees sur la
plateforme sont sensibles et couvertes par le present accord.

Article 1 - Confidentialite des donnees
L'Utilisateur s'engage a ne pas divulguer, communiquer, publier, reproduire,
ceder ou exploiter, sous quelque forme et sur quelque support que ce soit,
les informations obtenues via la plateforme et concernant d'autres
Utilisateurs (portefeuilles, BioSkills, blocs etendus, cotations,
transactions, historique, metadonnees), sans autorisation ecrite prealable
et explicite de leur proprietaire.

Article 2 - Non-concurrence et non-extraction massive
L'Utilisateur s'interdit d'utiliser les donnees agregees ou individuelles
issues de la plateforme pour : (i) developper, entrainer ou alimenter un
service concurrent ; (ii) constituer une base de donnees revendable ;
(iii) proceder a une extraction automatisee (scraping) des profils publies.

Article 3 - Propriete intellectuelle
Les BioSkills, illustrations et blocs etendus que l'Utilisateur saisit ou
televerse restent sa pleine propriete. En les publiant sur la plateforme,
l'Utilisateur concede a Bahyo une licence non exclusive, non cessible et
revocable, pour les afficher, qualifier, indexer et permettre leur cotation
dans le cadre du service. La cloture du compte revoque cette licence.

Article 4 - Elements sensibles et blocs chiffres
L'Utilisateur s'interdit toute tentative d'acces, de dechiffrement ou de
contournement des mecanismes de protection des blocs etendus chiffres
appartenant a d'autres Utilisateurs, hors des voies prevues par la Bourse
Bahyo (Etage 2).

Article 5 - Usage de bonne foi
L'Utilisateur s'engage a utiliser la plateforme conformement a sa vocation :
construire, valoriser et echanger des competences reelles, dans le respect
de la verite, de la dignite d'autrui et des lois en vigueur.

Article 6 - Duree et sanctions
Le present accord prend effet a la creation du compte. Les obligations de
confidentialite (art. 1, 2 et 4) subsistent 24 mois apres la cloture du
compte. Tout manquement pourra entrainer, sans prejudice des autres
sanctions applicables : suppression du compte, poursuites civiles et
transmission aux autorites competentes en cas d'infraction penale.

Article 7 - Loi applicable
Le present accord est regi par le droit francais. Tout litige releve de la
competence exclusive des tribunaux du ressort du siege de Bahyo.

Version : ${NDA_VERSION}`;

const NDA_TEXT_EN = `CONFIDENTIALITY AGREEMENT — BAHYO

Between:
- Bahyo, operator of the platform https://bsx.bahyo.net (hereinafter "Bahyo")
- The User, natural person having created an account on the platform
  (hereinafter "the User")

Preamble
The Bahyo platform allows each User to build, qualify and value a portfolio
of BioSkills (BS) according to the 3A method (Aptitude - Act - Attestation).
Some information exchanged on the platform is sensitive and is covered by
this agreement.

Article 1 - Data confidentiality
The User undertakes not to disclose, communicate, publish, reproduce,
transfer or exploit, in any form and on any medium, information obtained
via the platform regarding other Users (portfolios, BioSkills, extended
blocks, valuations, transactions, history, metadata), without the prior
explicit written authorization of their owner.

Article 2 - Non-competition and no mass extraction
The User shall not use aggregated or individual data from the platform to:
(i) develop, train or feed a competing service; (ii) build a resellable
database; (iii) automate profile extraction (scraping) of published profiles.

Article 3 - Intellectual property
BioSkills, illustrations and extended blocks entered or uploaded by the
User remain their full property. By publishing them on the platform, the
User grants Bahyo a non-exclusive, non-transferable and revocable license
to display, qualify, index and enable their valuation within the service.
Account closure revokes this license.

Article 4 - Sensitive elements and encrypted blocks
The User shall refrain from any attempt to access, decrypt or bypass the
protection mechanisms of encrypted extended blocks belonging to other
Users, outside the channels provided by the Bahyo Exchange (Level 2).

Article 5 - Good faith use
The User undertakes to use the platform in accordance with its purpose:
building, valuing and exchanging real skills, respecting truth, the
dignity of others and applicable laws.

Article 6 - Duration and sanctions
This agreement takes effect upon account creation. Confidentiality
obligations (art. 1, 2 and 4) survive for 24 months after account closure.
Any breach may result, without prejudice to other applicable sanctions:
account deletion, civil proceedings and transmission to the competent
authorities in the event of a criminal offense.

Article 7 - Applicable law
This agreement is governed by French law. Any dispute falls within the
exclusive jurisdiction of the courts of Bahyo's registered office.

Version: ${NDA_VERSION}`;

const NDA_TEXT = NDA_TEXT_FR; // rétrocompat

// ── Helpers email ─────────────────────────────────────────────────────────────
function creerMailer() {
  const port = parseInt(process.env.SMTP_PORT) || 25;
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'localhost',
    port,
    secure: port === 465,
    ignoreTLS: port === 25,
    tls: { rejectUnauthorized: false },
    ...(process.env.SMTP_USER ? {
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    } : {}),
  });
}

function genererToken() {
  return randomBytes(32).toString('hex');
}

async function envoyerEmailVerification(email, displayName, token) {
  const from     = process.env.SMTP_FROM || 'no-reply@bahyo.net';
  const frontUrl = process.env.FRONTEND_URL || 'https://bahyo.net';
  const lien     = `${process.env.BFF_URL || 'https://bsx.bahyo.net'}/auth/verify-email?token=${token}`;

  const mailer = creerMailer();
  await mailer.sendMail({
    from,
    to: email,
    subject: 'Bahyo — Activez votre compte',
    text: `Bonjour ${displayName || ''},\n\nCliquez sur ce lien pour activer votre compte Bahyo (valable 24h) :\n${lien}\n\nSi vous n'avez pas cree de compte, ignorez ce message.\n\nL'equipe Bahyo`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#0f1f3d">Activez votre compte Bahyo</h2>
        <p>Bonjour <strong>${displayName || ''}</strong>,</p>
        <p>Cliquez sur le bouton ci-dessous pour valider votre adresse email. Ce lien est valable <strong>24 heures</strong>.</p>
        <a href="${lien}" style="display:inline-block;margin:20px 0;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Activer mon compte
        </a>
        <p style="color:#6b7280;font-size:13px">Ou copiez ce lien dans votre navigateur :<br>${lien}</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
        <p style="color:#9ca3af;font-size:12px">Si vous n'avez pas cree de compte Bahyo, ignorez ce message.</p>
      </div>`,
  });
}

async function envoyerEmailResetPassword(email, displayName, resetToken) {
  const from     = process.env.SMTP_FROM || 'no-reply@bahyo.net';
  const frontUrl = process.env.FRONTEND_URL || 'https://bsx.bahyo.net';
  const lien     = `${frontUrl}/?reset=${resetToken}`;

  const mailer = creerMailer();
  await mailer.sendMail({
    from,
    to: email,
    subject: 'Bahyo — Reinitialisation du mot de passe',
    text: `Bonjour ${displayName || ''},\n\nVous avez demande la reinitialisation de votre mot de passe Bahyo. Cliquez sur ce lien (valable 30 minutes) :\n${lien}\n\nSi vous n'etes pas a l'origine de cette demande, ignorez ce message : votre mot de passe restera inchange.\n\nL'equipe Bahyo`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#0f1f3d">Reinitialisation de votre mot de passe</h2>
        <p>Bonjour <strong>${displayName || ''}</strong>,</p>
        <p>Vous avez demande la reinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous. Ce lien est valable <strong>30 minutes</strong>.</p>
        <a href="${lien}" style="display:inline-block;margin:20px 0;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Definir un nouveau mot de passe
        </a>
        <p style="color:#6b7280;font-size:13px">Ou copiez ce lien dans votre navigateur :<br>${lien}</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
        <p style="color:#9ca3af;font-size:12px">Si vous n'etes pas a l'origine de cette demande, ignorez ce message. Votre mot de passe restera inchange.</p>
      </div>`,
  });
}

async function envoyerEmailApprobationAdmin(user) {
  const adminEmail = process.env.ADMIN_EMAIL;
  if (!adminEmail) {
    console.warn('[AUTH] ADMIN_EMAIL non defini — validation admin desactivee');
    return;
  }
  const from     = process.env.SMTP_FROM || 'no-reply@bahyo.net';
  const bffUrl   = process.env.BFF_URL   || 'https://bsx.bahyo.net';

  const approveTok = jwt.sign(
    { userId: user.id, scope: 'admin_approve' },
    process.env.JWT_SECRET,
    { expiresIn: ADMIN_TOKEN_TTL }
  );
  const rejectTok = jwt.sign(
    { userId: user.id, scope: 'admin_reject' },
    process.env.JWT_SECRET,
    { expiresIn: ADMIN_TOKEN_TTL }
  );

  const approveUrl = `${bffUrl}/auth/admin/approve?token=${approveTok}`;
  const rejectUrl  = `${bffUrl}/auth/admin/reject?token=${rejectTok}`;

  const mailer = creerMailer();
  await mailer.sendMail({
    from,
    to: adminEmail,
    subject: `Bahyo — Nouvelle inscription a valider : ${user.email}`,
    text: `Un nouveau compte Bahyo est en attente de validation :

Email        : ${user.email}
Nom          : ${user.display_name || '(non renseigne)'}
LinkedIn     : ${user.ln_url || '(non renseigne)'}
Inscrit le   : ${new Date(user.created_at).toLocaleString('fr-FR')}

Approuver le compte :
${approveUrl}

Rejeter (suppression du compte) :
${rejectUrl}

Ces liens sont valables 7 jours.`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:auto">
        <h2 style="color:#0f1f3d">Nouvelle inscription a valider</h2>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:6px 10px;color:#6b7280">Email</td><td style="padding:6px 10px"><strong>${user.email}</strong></td></tr>
          <tr><td style="padding:6px 10px;color:#6b7280">Nom</td><td style="padding:6px 10px">${user.display_name || '<em>non renseigne</em>'}</td></tr>
          <tr><td style="padding:6px 10px;color:#6b7280">LinkedIn</td><td style="padding:6px 10px">${user.ln_url ? `<a href="https://${user.ln_url}">${user.ln_url}</a>` : '<em>non renseigne</em>'}</td></tr>
          <tr><td style="padding:6px 10px;color:#6b7280">Inscrit le</td><td style="padding:6px 10px">${new Date(user.created_at).toLocaleString('fr-FR')}</td></tr>
        </table>
        <div style="margin:24px 0">
          <a href="${approveUrl}" style="display:inline-block;padding:12px 24px;background:#059669;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;margin-right:8px">
            ✓ Approuver le compte
          </a>
          <a href="${rejectUrl}" style="display:inline-block;padding:12px 24px;background:#dc2626;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
            ✗ Rejeter (suppression)
          </a>
        </div>
        <p style="color:#9ca3af;font-size:12px">Ces liens sont valables 7 jours. La suppression est irreversible.</p>
      </div>`,
  });
}

async function envoyerEmailApprouve(email, displayName) {
  const from     = process.env.SMTP_FROM || 'no-reply@bahyo.net';
  const frontUrl = process.env.FRONTEND_URL || 'https://bsx.bahyo.net';
  const mailer = creerMailer();
  await mailer.sendMail({
    from,
    to: email,
    subject: 'Bahyo — Votre compte a ete approuve',
    text: `Bonjour ${displayName || ''},\n\nVotre compte Bahyo a ete approuve. Vous pouvez maintenant vous connecter :\n${frontUrl}\n\nL'equipe Bahyo`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto">
        <h2 style="color:#0f1f3d">Bienvenue sur Bahyo !</h2>
        <p>Bonjour <strong>${displayName || ''}</strong>,</p>
        <p>Votre compte a ete <strong style="color:#059669">approuve</strong>. Vous pouvez maintenant vous connecter et commencer a constituer votre portefeuille de competences.</p>
        <a href="${frontUrl}" style="display:inline-block;margin:20px 0;padding:12px 24px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Se connecter
        </a>
      </div>`,
  });
}

async function envoyerEmailRejete(email, displayName) {
  const from   = process.env.SMTP_FROM || 'no-reply@bahyo.net';
  const mailer = creerMailer();
  await mailer.sendMail({
    from,
    to: email,
    subject: 'Bahyo — Votre inscription n\'a pas ete retenue',
    text: `Bonjour ${displayName || ''},\n\nAprès examen, votre demande d'inscription a Bahyo n'a pas ete retenue. Si vous pensez qu'il s'agit d'une erreur, vous pouvez contacter l'equipe.\n\nL'equipe Bahyo`,
  });
}

async function envoyerEmailBienvenue(email, displayName) {
  const from = process.env.SMTP_FROM || 'no-reply@bahyo.net';
  const mailer = creerMailer();
  await mailer.sendMail({
    from,
    to: email,
    subject: 'Bahyo — Compte active, bienvenue !',
    text: `Bonjour ${displayName || ''},\n\nVotre compte Bahyo est active. Connectez-vous sur https://bahyo.net pour commencer.\n\nL'equipe Bahyo`,
  });
}

// ── GET /auth/nda ─────────────────────────────────────────────────────────────
// Renvoie le texte courant de l'accord de confidentialite + sa version.
// Priorite : version active en base (bahyo_nda) ; sinon fallback constantes.
// Query params : ?lang=fr (defaut) | en
router.get('/nda', async (req, res) => {
  const lang = (req.query.lang || 'fr').toLowerCase();
  try {
    const { rows } = await query(
      'SELECT version, texte FROM bahyo_nda WHERE lang = $1 AND actif = TRUE LIMIT 1',
      [lang]
    );
    if (rows[0]) {
      return res.json({ version: rows[0].version, lang, text: rows[0].texte, source: 'db' });
    }
  } catch { /* silencieux -> fallback */ }
  // Fallback : constantes
  const text = lang === 'en' ? NDA_TEXT_EN : NDA_TEXT_FR;
  res.json({ version: NDA_VERSION, lang, text, source: 'fallback' });
});

// ── POST /auth/register ───────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password, display_name, ln_url, nda_accepted } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Mot de passe minimum 8 caracteres' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email invalide' });
    }

    // Validation avancee : MX + blacklist des domaines jetables
    const valid = await validerEmail(email);
    if (!valid.ok) {
      return res.status(400).json({ error: valid.raison, code: 'EMAIL_INVALIDE' });
    }

    if (!nda_accepted) {
      return res.status(400).json({
        error: 'Vous devez accepter l\'accord de confidentialite pour creer un compte.',
        code:  'NDA_REQUIRED',
      });
    }

    const lnUrlNorm = ln_url
      ? ln_url.trim().replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//, 'linkedin.com/in/')
      : null;

    const emailLc = email.toLowerCase();
    const existing = await query('SELECT id FROM bahyo_user WHERE email = $1', [emailLc]);
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'Email deja utilise' });
    }

    // Verifier la whitelist : les emails whitelistes sont auto-approuves
    const wl = await query('SELECT motif FROM bahyo_whitelist_email WHERE email = $1', [emailLc]);
    const estWhitelist = wl.rows.length > 0;

    const rounds       = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const passwordHash = await bcrypt.hash(password, rounds);
    const emailToken   = genererToken();
    const tokenExpires = new Date(Date.now() + EMAIL_TOKEN_TTL_H * 3600 * 1000);
    const ndaSignedAt  = new Date();

    // Audit trail NDA : hash SHA-256 du texte + IP + user-agent
    const ndaHash      = createHash('sha256').update(NDA_TEXT).digest('hex');
    const clientIp     = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const userAgent    = (req.headers['user-agent'] || '').substring(0, 500);

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO bahyo_user
           (email, password_hash, display_name, ln_url,
            email_verified, must_change_password, email_token, email_token_expires_at,
            nda_signed_at, nda_version, nda_ip, nda_user_agent, nda_text_hash,
            account_approved)
         VALUES ($1, $2, $3, $4, FALSE, TRUE, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id, email, display_name, ln_url, created_at`,
        [emailLc, passwordHash, display_name || null, lnUrlNorm,
         emailToken, tokenExpires, ndaSignedAt, NDA_VERSION,
         clientIp, userAgent, ndaHash, estWhitelist]
      );
      const user = rows[0];

      await client.query(
        `INSERT INTO bahyo_portfolio_user (user_id, statut) VALUES ($1, 'BROUILLON')`,
        [user.id]
      );
      return { ...user, estWhitelist };
    });

    // Envoi email en arriere-plan (ne bloque pas la reponse)
    envoyerEmailVerification(result.email, result.display_name, emailToken).catch(e => {
      console.error('[AUTH] Erreur envoi email verification:', e.message);
    });

    await auditLog(result.id, 'INSCRIPTION', 'user', result.id,
                   { email, ln_url: lnUrlNorm, whitelist: result.estWhitelist, nda_version: NDA_VERSION }, req);

    res.status(201).json({
      message: result.estWhitelist
        ? 'Compte cree (whitelist). Verifiez votre email pour activer votre compte — pas de validation admin requise.'
        : 'Compte cree. Verifiez votre email puis attendez la validation par un administrateur.',
      email: result.email,
      whitelist: result.estWhitelist,
    });
  } catch (err) {
    console.error('[AUTH] Erreur inscription:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── GET /auth/verify-email ────────────────────────────────────────────────────
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Token manquant.');

    const { rows } = await query(
      `SELECT id, email, display_name, ln_url, created_at, account_approved
       FROM bahyo_user
       WHERE email_token = $1
         AND email_token_expires_at > NOW()
         AND email_verified = FALSE`,
      [token]
    );

    const frontUrl = process.env.FRONTEND_URL || 'https://bsx.bahyo.net';

    if (!rows[0]) {
      return res.redirect(`${frontUrl}?verified=0`);
    }

    const user = rows[0];
    await query(
      `UPDATE bahyo_user
       SET email_verified = TRUE, email_token = NULL, email_token_expires_at = NULL
       WHERE id = $1`,
      [user.id]
    );

    await auditLog(user.id, 'EMAIL_VERIFIE', 'user', user.id, null, req);

    // Si le compte n'est pas encore approuve (non whitelist), notifier l'admin
    if (!user.account_approved) {
      envoyerEmailApprobationAdmin(user).catch(e => {
        console.error('[AUTH] Erreur envoi email admin:', e.message);
      });
      return res.redirect(`${frontUrl}?verified=1&pending=1`);
    }

    // Whitelist : deja approuve, envoyer email de bienvenue directement
    envoyerEmailBienvenue(user.email, user.display_name).catch(() => {});
    res.redirect(`${frontUrl}?verified=1`);
  } catch (err) {
    console.error('[AUTH] Erreur verify-email:', err.message);
    res.status(500).send('Erreur serveur.');
  }
});

// ── GET /auth/admin/approve ───────────────────────────────────────────────────
router.get('/admin/approve', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Token manquant.');

    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).send('Lien expire ou invalide.'); }

    if (decoded.scope !== 'admin_approve') {
      return res.status(403).send('Token invalide.');
    }

    const { rows } = await query(
      `SELECT id, email, display_name, account_approved FROM bahyo_user WHERE id = $1`,
      [decoded.userId]
    );
    if (!rows[0]) return res.status(404).send('Compte introuvable (deja supprime ?).');

    const user = rows[0];

    if (user.account_approved) {
      return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>Deja approuve</h2>
        <p>Le compte <strong>${user.email}</strong> est deja approuve.</p>
      </body></html>`);
    }

    await query(
      `UPDATE bahyo_user
       SET account_approved = TRUE, approved_at = NOW(), approved_by = $2
       WHERE id = $1`,
      [user.id, process.env.ADMIN_EMAIL || 'admin']
    );

    await auditLog(user.id, 'COMPTE_APPROUVE', 'user', user.id, null, req);

    envoyerEmailApprouve(user.email, user.display_name).catch(e => {
      console.error('[AUTH] Erreur email approuve:', e.message);
    });

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2 style="color:#059669">✓ Compte approuve</h2>
      <p>Le compte <strong>${user.email}</strong> a ete approuve. L'utilisateur a ete notifie par email.</p>
    </body></html>`);
  } catch (err) {
    console.error('[AUTH] Erreur admin/approve:', err.message);
    res.status(500).send('Erreur serveur.');
  }
});

// ── GET /auth/admin/reject ────────────────────────────────────────────────────
router.get('/admin/reject', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send('Token manquant.');

    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).send('Lien expire ou invalide.'); }

    if (decoded.scope !== 'admin_reject') {
      return res.status(403).send('Token invalide.');
    }

    const { rows } = await query(
      `SELECT id, email, display_name FROM bahyo_user WHERE id = $1`,
      [decoded.userId]
    );
    if (!rows[0]) return res.status(404).send('Compte introuvable (deja supprime ?).');

    const user = rows[0];

    // Notifier avant suppression
    envoyerEmailRejete(user.email, user.display_name).catch(() => {});

    await auditLog(user.id, 'COMPTE_REJETE', 'user', user.id, { email: user.email }, req);

    await query(`DELETE FROM bahyo_user WHERE id = $1`, [user.id]);

    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2 style="color:#dc2626">✗ Compte rejete et supprime</h2>
      <p>Le compte <strong>${user.email}</strong> a ete supprime. L'utilisateur a ete notifie.</p>
    </body></html>`);
  } catch (err) {
    console.error('[AUTH] Erreur admin/reject:', err.message);
    res.status(500).send('Erreur serveur.');
  }
});

// ── POST /auth/resend-verification ───────────────────────────────────────────
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const { rows } = await query(
      `SELECT id, display_name FROM bahyo_user WHERE email = $1 AND email_verified = FALSE`,
      [email.toLowerCase()]
    );

    // Reponse neutre (ne pas confirmer si l'email existe)
    if (!rows[0]) {
      return res.json({ message: 'Si ce compte existe et n\'est pas verifie, un email a ete envoye.' });
    }

    const emailToken   = genererToken();
    const tokenExpires = new Date(Date.now() + EMAIL_TOKEN_TTL_H * 3600 * 1000);

    await query(
      `UPDATE bahyo_user SET email_token = $1, email_token_expires_at = $2 WHERE id = $3`,
      [emailToken, tokenExpires, rows[0].id]
    );

    envoyerEmailVerification(email.toLowerCase(), rows[0].display_name, emailToken).catch(e => {
      console.error('[AUTH] Erreur renvoi email:', e.message);
    });

    res.json({ message: 'Email de verification renvoye.' });
  } catch (err) {
    console.error('[AUTH] Erreur resend-verification:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password, totp_code } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email et mot de passe requis' });
    }

    const { rows } = await query(
      `SELECT id, email, display_name, password_hash, totp_enabled, totp_secret,
              login_attempts, locked_until, wallet_address,
              ln_url, created_at, email_verified, must_change_password,
              account_approved, is_superadmin,
              suspended_at, suspended_reason, closed_at, force_nda_resign
       FROM bahyo_user WHERE email = $1`,
      [email.toLowerCase()]
    );
    const user = rows[0];

    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(429).json({
        error: `Compte verrouille. Reessayez dans ${minutes} minute(s).`
      });
    }

    const validPassword = user
      ? await bcrypt.compare(password, user.password_hash)
      : await bcrypt.compare(password, '$2b$12$invalidhashfortimingatack');

    if (!user || !validPassword) {
      if (user) {
        const maxAttempts = parseInt(process.env.MAX_LOGIN_ATTEMPTS) || 5;
        const newAttempts = (user.login_attempts || 0) + 1;
        const lockoutMs   = (parseInt(process.env.LOCKOUT_MINUTES) || 15) * 60000;
        const lockedUntil = newAttempts >= maxAttempts ? new Date(Date.now() + lockoutMs) : null;
        await query(
          `UPDATE bahyo_user SET login_attempts = $1, locked_until = $2 WHERE id = $3`,
          [newAttempts, lockedUntil, user.id]
        );
      }
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    // Compte ferme (soft delete)
    if (user.closed_at) {
      return res.status(403).json({
        error: 'Ce compte a ete ferme. Contactez l\'administration si vous pensez qu\'il s\'agit d\'une erreur.',
        code:  'ACCOUNT_CLOSED',
      });
    }

    // Compte suspendu
    if (user.suspended_at) {
      return res.status(403).json({
        error: `Votre compte est suspendu. Motif : ${user.suspended_reason || 'non specifie'}. Contactez l'administration.`,
        code:  'ACCOUNT_SUSPENDED',
      });
    }

    // Email non verifie
    if (!user.email_verified) {
      return res.status(403).json({
        error: 'Email non verifie. Consultez votre boite mail pour activer votre compte.',
        code:  'EMAIL_NOT_VERIFIED',
      });
    }

    // Compte pas encore approuve par l'admin
    if (!user.account_approved) {
      return res.status(403).json({
        error: 'Votre compte est en attente d\'approbation par un administrateur.',
        code:  'ACCOUNT_PENDING',
      });
    }

    // Force resign NDA (legacy accounts sans nda_signed_at), sauf whitelist
    if (user.force_nda_resign) {
      // Verifier si l'email est whitelist -> alors on exempte
      const wl = await query('SELECT 1 FROM bahyo_whitelist_email WHERE email = $1', [user.email]);
      if (wl.rows[0]) {
        await query(
          `UPDATE bahyo_user SET force_nda_resign = FALSE,
             nda_signed_at = COALESCE(nda_signed_at, NOW()),
             nda_version   = COALESCE(nda_version, 'exempt-whitelist')
           WHERE id = $1`,
          [user.id]
        );
      } else {
        const changeToken = jwt.sign(
          { userId: user.id, scope: 'resign_nda' },
          process.env.JWT_SECRET,
          { expiresIn: '15m' }
        );
        return res.json({
          must_resign_nda: true,
          change_token: changeToken,
          message: 'Vous devez accepter l\'accord de confidentialite pour continuer.',
        });
      }
    }

    // 2FA
    if (user.totp_enabled) {
      if (!totp_code) {
        return res.status(200).json({ requires_2fa: true, message: 'Code 2FA requis' });
      }
      const valid2fa = speakeasy.totp.verify({
        secret: user.totp_secret, encoding: 'base32', token: totp_code, window: 2
      });
      if (!valid2fa) {
        return res.status(401).json({ error: 'Code 2FA invalide' });
      }
    }

    await query(
      `UPDATE bahyo_user SET login_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1`,
      [user.id]
    );
    await auditLog(user.id, 'CONNEXION', 'user', user.id, null, req);

    // Premier login : changement de mot de passe oblige
    if (user.must_change_password) {
      const changeToken = jwt.sign(
        { userId: user.id, scope: 'change_password' },
        process.env.JWT_SECRET,
        { expiresIn: CHANGE_TOKEN_TTL }
      );
      return res.json({
        must_change_password: true,
        change_token: changeToken,
      });
    }

    const is2017 = user.created_at && new Date(user.created_at) < SEUIL_2017;
    const { accessToken, refreshToken } = generateTokens(user.id);

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    await query(
      `INSERT INTO bahyo_user_session (user_id, refresh_token, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, refreshToken, req.ip, req.headers['user-agent'], expiry]
    );

    res.json({
      user: {
        id:             user.id,
        email:          user.email,
        display_name:   user.display_name,
        wallet_address: user.wallet_address,
        totp_enabled:   user.totp_enabled,
        ln_url:         user.ln_url || null,
        is_2017:        is2017,
        is_superadmin:  !!user.is_superadmin,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('[AUTH] Erreur connexion:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /auth/set-password ───────────────────────────────────────────────────
// Appele au 1er login avec le change_token (JWT scope=change_password)
router.post('/set-password', async (req, res) => {
  try {
    const { change_token, new_password } = req.body;
    if (!change_token || !new_password) {
      return res.status(400).json({ error: 'change_token et new_password requis' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Mot de passe minimum 8 caracteres' });
    }

    let decoded;
    try {
      decoded = jwt.verify(change_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Token expire ou invalide. Reconnectez-vous.' });
    }

    if (decoded.scope !== 'change_password') {
      return res.status(403).json({ error: 'Token invalide' });
    }

    const { rows } = await query(
      `SELECT id, email, display_name, ln_url, created_at, wallet_address, totp_enabled
       FROM bahyo_user WHERE id = $1`,
      [decoded.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const user = rows[0];
    const rounds       = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const passwordHash = await bcrypt.hash(new_password, rounds);

    await query(
      `UPDATE bahyo_user SET password_hash = $1, must_change_password = FALSE WHERE id = $2`,
      [passwordHash, user.id]
    );

    await auditLog(user.id, 'MOT_DE_PASSE_DEFINI', 'user', user.id, null, req);

    const is2017 = user.created_at && new Date(user.created_at) < SEUIL_2017;
    const { accessToken, refreshToken } = generateTokens(user.id);

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    await query(
      `INSERT INTO bahyo_user_session (user_id, refresh_token, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, refreshToken, req.ip, req.headers['user-agent'], expiry]
    );

    res.json({
      user: {
        id:             user.id,
        email:          user.email,
        display_name:   user.display_name,
        wallet_address: user.wallet_address,
        totp_enabled:   user.totp_enabled,
        ln_url:         user.ln_url || null,
        is_2017:        is2017,
      },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    console.error('[AUTH] Erreur set-password:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /auth/forgot-password ────────────────────────────────────────────────
// Envoie un email avec un lien de reinitialisation. Reponse toujours neutre.
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const { rows } = await query(
      `SELECT id, email, display_name, email_verified
       FROM bahyo_user WHERE email = $1`,
      [email.toLowerCase()]
    );
    const user = rows[0];

    // Reponse neutre systematiquement (evite l'enumeration)
    const reponseNeutre = {
      message: 'Si un compte existe pour cette adresse, un email de reinitialisation a ete envoye.'
    };

    // Seuls les comptes verifies peuvent reinitialiser (pour un compte non verifie, l'user
    // doit utiliser /auth/resend-verification puis definir son mot de passe au 1er login)
    if (!user || !user.email_verified) {
      return res.json(reponseNeutre);
    }

    const resetToken = jwt.sign(
      { userId: user.id, scope: 'reset_password' },
      process.env.JWT_SECRET,
      { expiresIn: RESET_TOKEN_TTL }
    );

    envoyerEmailResetPassword(user.email, user.display_name, resetToken).catch(e => {
      console.error('[AUTH] Erreur envoi email reset:', e.message);
    });

    await auditLog(user.id, 'DEMANDE_RESET_PASSWORD', 'user', user.id, null, req);

    res.json(reponseNeutre);
  } catch (err) {
    console.error('[AUTH] Erreur forgot-password:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /auth/reset-password ─────────────────────────────────────────────────
// Valide le reset_token JWT, applique le nouveau mot de passe, revoque les sessions
router.post('/reset-password', async (req, res) => {
  try {
    const { reset_token, new_password } = req.body;
    if (!reset_token || !new_password) {
      return res.status(400).json({ error: 'reset_token et new_password requis' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Mot de passe minimum 8 caracteres' });
    }

    let decoded;
    try {
      decoded = jwt.verify(reset_token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Lien expire ou invalide. Recommencez la demande.' });
    }

    if (decoded.scope !== 'reset_password') {
      return res.status(403).json({ error: 'Token invalide' });
    }

    const { rows } = await query(
      `SELECT id, email FROM bahyo_user WHERE id = $1`,
      [decoded.userId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const user         = rows[0];
    const rounds       = parseInt(process.env.BCRYPT_ROUNDS) || 12;
    const passwordHash = await bcrypt.hash(new_password, rounds);

    await withTransaction(async (client) => {
      // Nouveau mot de passe, reinit compteur d'echecs, deverrouille
      await client.query(
        `UPDATE bahyo_user
         SET password_hash = $1, login_attempts = 0, locked_until = NULL,
             must_change_password = FALSE
         WHERE id = $2`,
        [passwordHash, user.id]
      );
      // Revoque toutes les sessions actives (force reconnexion partout)
      await client.query(
        `DELETE FROM bahyo_user_session WHERE user_id = $1`,
        [user.id]
      );
    });

    await auditLog(user.id, 'RESET_PASSWORD', 'user', user.id, null, req);

    res.json({ message: 'Mot de passe reinitialise. Vous pouvez maintenant vous connecter.' });
  } catch (err) {
    console.error('[AUTH] Erreur reset-password:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /auth/resign-nda ─────────────────────────────────────────────────────
// Legacy accounts sans nda_signed_at : signature forcee au login.
router.post('/resign-nda', async (req, res) => {
  try {
    const { change_token, nda_accepted } = req.body;
    if (!change_token || !nda_accepted) {
      return res.status(400).json({ error: 'change_token et nda_accepted requis' });
    }
    let decoded;
    try { decoded = jwt.verify(change_token, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Token expire. Reconnectez-vous.' }); }
    if (decoded.scope !== 'resign_nda') return res.status(403).json({ error: 'Token invalide' });

    const ndaHash   = createHash('sha256').update(NDA_TEXT_FR).digest('hex');
    const clientIp  = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const userAgent = (req.headers['user-agent'] || '').substring(0, 500);

    await query(
      `UPDATE bahyo_user
       SET nda_signed_at = NOW(), nda_version = $1, nda_ip = $2,
           nda_user_agent = $3, nda_text_hash = $4, force_nda_resign = FALSE
       WHERE id = $5`,
      [NDA_VERSION, clientIp, userAgent, ndaHash, decoded.userId]
    );
    await auditLog(decoded.userId, 'NDA_RESIGNE', 'user', decoded.userId, { version: NDA_VERSION }, req);

    res.json({ message: 'Accord de confidentialite signe. Veuillez vous reconnecter.' });
  } catch (err) {
    console.error('[AUTH] Erreur resign-nda:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /auth/refresh ────────────────────────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token manquant' });

    const { rows } = await query(
      `SELECT s.user_id, s.expires_at, u.email
       FROM bahyo_user_session s
       JOIN bahyo_user u ON u.id = s.user_id
       WHERE s.refresh_token = $1`,
      [refresh_token]
    );

    if (!rows[0] || new Date(rows[0].expires_at) < new Date()) {
      await query('DELETE FROM bahyo_user_session WHERE refresh_token = $1', [refresh_token]);
      return res.status(401).json({ error: 'Session expiree, reconnectez-vous' });
    }

    const { user_id } = rows[0];
    const { accessToken, refreshToken: newRefreshToken } = generateTokens(user_id);

    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 30);
    await query(
      `UPDATE bahyo_user_session SET refresh_token = $1, expires_at = $2 WHERE refresh_token = $3`,
      [newRefreshToken, expiry, refresh_token]
    );

    res.json({ accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    console.error('[AUTH] Erreur refresh:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      await query('DELETE FROM bahyo_user_session WHERE refresh_token = $1', [refresh_token]);
    }
    res.json({ message: 'Deconnecte' });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /auth/2fa/setup ──────────────────────────────────────────────────────
router.post('/2fa/setup', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Non authentifie' });
    }
    const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);

    const { rows } = await query('SELECT email FROM bahyo_user WHERE id = $1', [decoded.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });

    const secret = speakeasy.generateSecret({ name: `Bahyo (${rows[0].email})`, length: 32 });
    await query('UPDATE bahyo_user SET totp_secret = $1 WHERE id = $2', [secret.base32, decoded.userId]);

    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);
    res.json({
      secret: secret.base32,
      qr_code: qrCodeUrl,
      message: 'Scannez le QR code avec votre application 2FA, puis validez avec /2fa/verify',
    });
  } catch (err) {
    console.error('[AUTH] Erreur 2FA setup:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ── POST /auth/2fa/verify ─────────────────────────────────────────────────────
router.post('/2fa/verify', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const decoded    = jwt.verify(authHeader?.slice(7), process.env.JWT_SECRET);
    const { totp_code } = req.body;

    const { rows } = await query('SELECT totp_secret FROM bahyo_user WHERE id = $1', [decoded.userId]);
    const valid = speakeasy.totp.verify({
      secret: rows[0]?.totp_secret, encoding: 'base32', token: totp_code, window: 2
    });
    if (!valid) return res.status(400).json({ error: 'Code 2FA invalide' });

    await query('UPDATE bahyo_user SET totp_enabled = TRUE WHERE id = $1', [decoded.userId]);
    await auditLog(decoded.userId, '2FA_ACTIVE', 'user', decoded.userId, null, req);
    res.json({ message: '2FA active avec succes' });
  } catch (err) {
    console.error('[AUTH] Erreur 2FA verify:', err.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

export default router;