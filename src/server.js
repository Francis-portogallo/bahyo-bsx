// src/server.js
// @version 1.5.0
// @date    2026-09-17
// @change  1.5.0 — Ajout du routeur atelier (annotation BS) monte sur /atelier.
//                  Assistant Mistral via src/services/mistral.js.
//          1.4.0 — Ajout du routeur webhook (GitHub auto-deploy) monte sur /github-deploy-hook.
//                  Monte avant express.json() pour preserver le body brut (HMAC).
//          1.3.0 — Ajout du routeur wallet (economie Talent) monte sur /wallet.
//          1.2.0 — Ajout du routeur admin (superadmin) monte sur /admin.
//          1.1.1 — CORS robuste : trim des origines + refus propre (au lieu de 500)
//          1.1.0 — Unification frontend + BFF sur bsx.bahyo.net (meme origine)
//                  - Route GET / sert public/index.html (via express)
//                  - Banner dynamique (plus de hardcode "PostgreSQL 17")
//                  - Version alignee sur healthcheck
//          1.0.0 — Version initiale BFF Bahyo
// ============================================================================
import express     from 'express';
import cors        from 'cors';
import helmet      from 'helmet';
import rateLimit   from 'express-rate-limit';
import dotenv      from 'dotenv';
import path        from 'path';
import { fileURLToPath } from 'url';
dotenv.config();

import authRoutes      from './routes/auth.js';
import sourcesRoutes   from './routes/sources.js';
import portfolioRoutes from './routes/portfolio.js';
import iaRoutes        from './routes/ia.js';
import adminRoutes     from './routes/admin.js';
import walletRoutes    from './routes/wallet.js';
import webhookRoutes   from './routes/webhook.js';
import atelierRoutes   from './routes/atelier.js';
import pool            from './db/pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app     = express();
const PORT    = process.env.PORT || 3001;
const VERSION = '1.5.0';

// ── Securite ─────────────────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https:'],
      imgSrc:     ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'", 'https:', 'data:'],
    },
  },
}));

// ── CORS (utile si un autre domaine appelle l'API) ───────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Pas d'Origin (curl, meme origine sans navigateur) OU origine autorisee
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    // Refus propre : pas de header CORS, pas d'exception 500
    console.warn(`[CORS] Origine refusee : ${origin}`);
    return callback(null, false);
  },
  credentials: true,
}));

// ── Rate limiting global ─────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de requetes. Reessayez dans 15 minutes.' },
}));

// Rate limiting strict pour l'auth
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Trop de tentatives d\'authentification.' },
});

// ── Webhook GitHub : monte AVANT express.json pour preserver le body brut ───
app.use('/github-deploy-hook', webhookRoutes);

// ── Middlewares ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.path}`);
    next();
  });
}

// ── Frontend : sert public/index.html sur / ──────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Sert les autres statiques (JS/CSS/images) depuis public/
// index: false pour ne pas court-circuiter la route ci-dessus
app.use(express.static(PUBLIC_DIR, { index: false }));

// ── Routes API ───────────────────────────────────────────────────────────────
app.use('/auth',      authLimiter, authRoutes);
app.use('/sources',   sourcesRoutes);
app.use('/portfolio', portfolioRoutes);
app.use('/ia',        iaRoutes);
app.use('/admin',     adminRoutes);
app.use('/wallet',    walletRoutes);
app.use('/atelier',   atelierRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT current_database() AS db, version() AS pg');
    res.json({
      status:    'ok',
      service:   'bahyo-bff',
      version:   VERSION,
      database:  rows[0].db,
      postgres:  rows[0].pg.split(' ').slice(0, 2).join(' '),
      env:       process.env.NODE_ENV || 'development',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'disconnected', error: err.message });
  }
});

// ── Gestion erreurs ──────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route introuvable : ${req.method} ${req.path}` });
});

app.use((err, req, res, next) => {
  console.error('[SERVER] Erreur non geree:', err.message);
  res.status(500).json({ error: 'Erreur serveur interne' });
});

// ── Demarrage ────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  let dbInfo = 'disconnected';
  try {
    const { rows } = await pool.query('SELECT current_database() AS db, version() AS pg');
    dbInfo = `${rows[0].db} (${rows[0].pg.split(' ').slice(0, 2).join(' ')})`;
  } catch { /* silencieux */ }

  const env = (process.env.NODE_ENV || 'development');
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║  BAHYO BFF v${VERSION.padEnd(6)}                                    ║
║  Port    : ${String(PORT).padEnd(46)} ║
║  Env     : ${env.padEnd(46)} ║
║  Base    : ${dbInfo.padEnd(46)} ║
╚═══════════════════════════════════════════════════════════╝`);
});

export default app;
