-- Schema base Bahyo -- qiyo9734_bahyo
-- version 000 | 2026-08-24 | PostgreSQL 9.6+

-- UUID generator without any extension (works on PostgreSQL 9.6+)
-- Uses md5(random + clock) cast to uuid -- not cryptographic but unique enough for PKs
CREATE OR REPLACE FUNCTION bahyo_uuid() RETURNS UUID AS $$
  SELECT md5(random()::text || clock_timestamp()::text)::uuid;
$$ LANGUAGE SQL;
-- Pure ASCII comments. No BEGIN/COMMIT. Uncheck "Paginer les resultats" before running.
--
-- Includes all columns from migrations 003 and 004 (ln_url, email_verified, etc.)
-- so those migrations are NOT needed on a fresh install.
-- Migration 001 still needs to run after this (adds ENUM + extraction tables).
-- Migration 002 is DEFERRED -- do NOT run it yet.
--
-- Run order on fresh install:
--   1. 000_schema_base.sql   (this file)
--   2. 001_portefeuille_brut.sql
--   3. Skip 002 (deferred)
--   4. Skip 003 and 004 (columns already here)

-- ============================================================
-- 1. bahyo_user
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_user (
  id                      UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  email                   TEXT NOT NULL UNIQUE,
  password_hash           TEXT NOT NULL,
  display_name            TEXT,
  avatar_url              TEXT,

  -- LinkedIn profile URL (stored without https://www.)
  ln_url                  TEXT,

  -- Email verification (migration 004 included)
  email_verified          BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password    BOOLEAN NOT NULL DEFAULT FALSE,
  email_token             TEXT,
  email_token_expires_at  TIMESTAMPTZ,

  -- 2FA (TOTP)
  totp_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  totp_secret             TEXT,

  -- Login security
  login_attempts          INT NOT NULL DEFAULT 0,
  locked_until            TIMESTAMPTZ,
  last_login_at           TIMESTAMPTZ,

  -- Blockchain (future)
  wallet_address          TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_email       ON bahyo_user(email);
CREATE INDEX IF NOT EXISTS idx_user_email_token ON bahyo_user(email_token) WHERE email_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_ln_url      ON bahyo_user(ln_url) WHERE ln_url IS NOT NULL;

-- ============================================================
-- 2. bahyo_user_session  (refresh tokens)
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_user_session (
  id            UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  user_id       UUID NOT NULL REFERENCES bahyo_user(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL UNIQUE,
  ip_address    TEXT,
  user_agent    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_session_user_id ON bahyo_user_session(user_id);

-- ============================================================
-- 3. bahyo_audit_log
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_audit_log (
  id           UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  user_id      UUID REFERENCES bahyo_user(id) ON DELETE SET NULL,
  action       TEXT NOT NULL,
  entite_type  TEXT,
  entite_id    UUID,
  payload_hash TEXT,
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user_id  ON bahyo_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action   ON bahyo_audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_created  ON bahyo_audit_log(created_at);

-- ============================================================
-- 4. bahyo_config  (key-value store for app settings)
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_config (
  cle        TEXT PRIMARY KEY,
  valeur     TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default config values
INSERT INTO bahyo_config (cle, valeur) VALUES
  ('ia_tarif_question_simple',   '1'),
  ('ia_tarif_analyse_bs',        '5'),
  ('ia_tarif_reanalyse_complete','20'),
  ('score_seuil_publication',    '60')
ON CONFLICT (cle) DO NOTHING;

-- ============================================================
-- 5. bahyo_portfolio_user
-- Note: migration 001 adds columns contrat_version, provenance_*,
--       source_resume, extraction_at via ALTER TABLE ADD COLUMN IF NOT EXISTS
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_portfolio_user (
  id                UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  user_id           UUID NOT NULL UNIQUE REFERENCES bahyo_user(id) ON DELETE CASCADE,
  statut            TEXT NOT NULL DEFAULT 'BROUILLON'
                      CHECK (statut IN ('BROUILLON','CONSTITUE','PUBLIE')),
  score_qualite     INT,
  tokens_alloues    INT NOT NULL DEFAULT 0,
  cotation_initiale NUMERIC,
  ico_hash          TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_user_id ON bahyo_portfolio_user(user_id);
CREATE INDEX IF NOT EXISTS idx_portfolio_statut  ON bahyo_portfolio_user(statut);

-- ============================================================
-- 6. bahyo_source  (uploaded files + LinkedIn/Instagram ZIPs)
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_source (
  id              UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  user_id         UUID NOT NULL REFERENCES bahyo_user(id) ON DELETE CASCADE,
  type            TEXT NOT NULL
                    CHECK (type IN ('FICHIER','URL','TEXTE_LIBRE','LINKEDIN_ZIP','INSTAGRAM_ZIP')),
  nom_fichier     TEXT,
  taille_octets   BIGINT,
  contenu_texte   TEXT,
  est_reference   BOOLEAN NOT NULL DEFAULT FALSE,
  poids_reference NUMERIC NOT NULL DEFAULT 1.0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_source_user_id ON bahyo_source(user_id);

-- ============================================================
-- 7. bahyo_token_wallet  (BAH token balances)
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_token_wallet (
  id            UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  user_id       UUID NOT NULL UNIQUE REFERENCES bahyo_user(id) ON DELETE CASCADE,
  solde         INT NOT NULL DEFAULT 0,
  total_gagne   INT NOT NULL DEFAULT 0,
  total_depense INT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- 8. bahyo_token_transaction
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_token_transaction (
  id           UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  user_id      UUID NOT NULL REFERENCES bahyo_user(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  montant      INT NOT NULL,
  solde_apres  INT NOT NULL,
  description  TEXT,
  reference_id UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_token_tx_user_id ON bahyo_token_transaction(user_id);

-- ============================================================
-- 9. bahyo_ia_session
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_ia_session (
  id                 UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  user_id            UUID NOT NULL REFERENCES bahyo_user(id) ON DELETE CASCADE,
  portfolio_id       UUID REFERENCES bahyo_portfolio_user(id) ON DELETE SET NULL,
  mode               TEXT NOT NULL DEFAULT 'CONSTITUTION'
                       CHECK (mode IN ('CONSTITUTION','OPTIMISATION')),
  messages           JSONB NOT NULL DEFAULT '[]',
  tokens_input       INT NOT NULL DEFAULT 0,
  tokens_output      INT NOT NULL DEFAULT 0,
  tokens_bah_debites INT NOT NULL DEFAULT 0,
  statut             TEXT NOT NULL DEFAULT 'ACTIF'
                       CHECK (statut IN ('ACTIF','ERREUR')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ia_session_user_id ON bahyo_ia_session(user_id);

-- ============================================================
-- 10. bahyo_bloc_etendu  (Etage 2 -- extended content blocks)
-- FK to bahyo_portfolio_bs_extrait is added via migration 002 (DEFERRED).
-- portfolio_bs_id is nullable until migration 002 runs.
-- ============================================================
CREATE TABLE IF NOT EXISTS bahyo_bloc_etendu (
  id                   UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  portfolio_bs_id      UUID,
  user_id              UUID NOT NULL REFERENCES bahyo_user(id) ON DELETE CASCADE,
  titre_public         TEXT,
  description_publique TEXT,
  type                 TEXT,
  prix_indicatif_eur   NUMERIC,
  contenu_chiffre      BYTEA,
  iv_chiffrement       BYTEA,
  hash_contenu         TEXT,
  nom_fichier_original TEXT,
  taille_octets        BIGINT,
  ordre                INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bloc_user_id       ON bahyo_bloc_etendu(user_id);
CREATE INDEX IF NOT EXISTS idx_bloc_portfolio_bs  ON bahyo_bloc_etendu(portfolio_bs_id);
