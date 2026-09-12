// src/routes/webhook.js
// @version 1.0.0
// @date    2026-09-12
// Route webhook GitHub : declenche ~/deploy-bsx.sh sur push main.
// - Validation HMAC SHA256 (secret dans .env : GITHUB_WEBHOOK_SECRET)
// - Utilise express.raw pour preserver le body brut avant HMAC
// - Deploy execute en background, reponse 202 immediate a GitHub
// ============================================================================
import express        from 'express';
import crypto         from 'crypto';
import { exec }       from 'child_process';
import fs             from 'fs';

const router = express.Router();

const SECRET      = process.env.GITHUB_WEBHOOK_SECRET;
const DEPLOY_SH   = process.env.DEPLOY_SCRIPT   || '/home2/qiyo9734/deploy-bsx.sh';
const LOG_FILE    = process.env.DEPLOY_LOG_FILE || '/home2/qiyo9734/deploy-bsx.log';
const ALLOWED_REF = 'refs/heads/main';

function log(line) {
  const entry = `${new Date().toISOString()} ${line}\n`;
  try { fs.appendFileSync(LOG_FILE, entry); } catch { /* silencieux */ }
  console.log('[webhook]', line);
}

// express.raw preserve le body brut necessaire pour l'HMAC
router.post('/', express.raw({ type: 'application/json', limit: '2mb' }), (req, res) => {

  if (!SECRET) {
    log('REFUS : GITHUB_WEBHOOK_SECRET non configure');
    return res.status(500).send('Server misconfigured\n');
  }

  const signature = req.headers['x-hub-signature-256'] || '';
  const event     = req.headers['x-github-event']      || '';

  // ── Validation signature HMAC SHA256 ─────────────────────────────────────
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(req.body).digest('hex');
  const sigOk = signature.length === expected.length &&
                crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!sigOk) {
    log(`REFUS signature invalide (event=${event})`);
    return res.status(401).send('Invalid signature\n');
  }

  // ── Ping GitHub ──────────────────────────────────────────────────────────
  if (event === 'ping') {
    log('PING OK');
    return res.status(200).send('pong\n');
  }

  if (event !== 'push') {
    log(`Ignore event=${event}`);
    return res.status(200).send(`Ignored event: ${event}\n`);
  }

  // ── Parse payload ────────────────────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    log(`REFUS JSON invalide : ${err.message}`);
    return res.status(400).send('Invalid JSON\n');
  }

  if (data.ref !== ALLOWED_REF) {
    log(`Ignore ref=${data.ref}`);
    return res.status(200).send(`Ignored ref: ${data.ref}\n`);
  }

  const commit = (data.after || 'unknown').substring(0, 7);
  const author = data.pusher?.name || '?';
  log(`DEPLOY commit=${commit} author=${author}`);

  // ── Execution deploy en background ───────────────────────────────────────
  const cmd = `${DEPLOY_SH} >> ${LOG_FILE} 2>&1`;
  const child = exec(cmd, { detached: true }, (err) => {
    if (err) log(`ERREUR deploy : ${err.message}`);
    else     log(`SUCCESS deploy commit=${commit}`);
  });
  child.unref();

  return res.status(202).send(`Deploy triggered (commit ${commit} by ${author})\n`);
});

export default router;
