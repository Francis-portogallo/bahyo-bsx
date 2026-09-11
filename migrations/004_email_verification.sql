-- Migration 004 : email verification + must_change_password
-- version 004 | 2026-08-24 | PostgreSQL 9.6+
-- Depends on 001_portefeuille_brut.sql
--
-- Existing rows: email_verified=TRUE, must_change_password=FALSE (safe default)
-- New registrations set these via INSERT (see auth.js v1.2.0)

ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS email_token TEXT;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS email_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_user_email_token ON bahyo_user(email_token) WHERE email_token IS NOT NULL;
