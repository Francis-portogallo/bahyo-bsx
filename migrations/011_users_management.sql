-- Migration 011 : gestion des comptes existants (suspension / cloture / re-NDA)
-- version 011 | 2026-08-27 | PostgreSQL 9.6+
-- Depends on 009_superadmin_audit.sql
-- Pure ASCII. No BEGIN/COMMIT.

-- Suspension
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS suspended_at     TIMESTAMPTZ;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS suspended_by     TEXT;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- Cloture (soft delete pour tracabilite)
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS closed_at        TIMESTAMPTZ;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS closed_by        TEXT;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS closed_reason    TEXT;

-- Forcer signature NDA au prochain login (legacy accounts sans nda_signed_at)
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS force_nda_resign BOOLEAN NOT NULL DEFAULT FALSE;

-- Index pour lister rapidement suspendus / fermes
CREATE INDEX IF NOT EXISTS idx_user_suspended ON bahyo_user(suspended_at) WHERE suspended_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_user_closed    ON bahyo_user(closed_at)    WHERE closed_at    IS NOT NULL;

-- Marquer les comptes existants sans NDA comme "force_nda_resign = TRUE"
-- pour qu'ils doivent le signer au prochain login
UPDATE bahyo_user SET force_nda_resign = TRUE
WHERE nda_signed_at IS NULL AND closed_at IS NULL;

-- Autorisations
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_user TO qiyo9734_postgres;
