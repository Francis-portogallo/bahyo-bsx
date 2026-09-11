-- Migration 005 : approbation admin des comptes
-- version 005 | 2026-08-25 | PostgreSQL 9.6+
-- Depends on 000_schema_base.sql
--
-- Nouveaux comptes : account_approved=FALSE (login bloque tant que non approuve)
-- Existant : account_approved=TRUE (ne pas verrouiller les comptes deja actifs)
-- Pure ASCII. No BEGIN/COMMIT. Uncheck "Paginer les resultats" avant execution.

ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS account_approved BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS approved_by TEXT;

-- Passer le defaut a FALSE pour les futurs comptes
ALTER TABLE bahyo_user ALTER COLUMN account_approved SET DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_user_pending_approval
  ON bahyo_user(created_at)
  WHERE account_approved = FALSE AND email_verified = TRUE;
