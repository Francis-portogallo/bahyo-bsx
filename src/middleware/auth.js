// src/middleware/auth.js
import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';

// Vérifie le JWT et attache req.user
export const requireAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    const token = header.slice(7);
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Vérifier que l'utilisateur existe toujours
    const { rows } = await query(
      'SELECT id, email, display_name, wallet_address, totp_enabled FROM bahyo_user WHERE id = $1',
      [decoded.userId]
    );

    if (!rows[0]) {
      return res.status(401).json({ error: 'Utilisateur introuvable' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expiré', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Token invalide' });
  }
};

// Génère access + refresh tokens
export const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );

  return { accessToken, refreshToken };
};

// Log audit immuable
export const auditLog = async (userId, action, entiteType, entiteId, payload, req) => {
  try {
    const crypto = await import('crypto');
    const payloadHash = payload
      ? crypto.default.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      : null;

    await query(
      `INSERT INTO bahyo_audit_log
         (user_id, action, entite_type, entite_id, payload_hash, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        action,
        entiteType,
        entiteId,
        payloadHash,
        req?.ip,
        req?.headers?.['user-agent']?.substring(0, 200)
      ]
    );
  } catch (err) {
    // Ne jamais faire échouer la requête principale pour un log
    console.error('[AUDIT] Erreur log:', err.message);
  }
};
