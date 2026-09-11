-- Migration 009 : superadmin + audit trail NDA + version NDA editable
-- version 009 | 2026-08-27 | PostgreSQL 9.6+
-- Depends on 008_nda_whitelist.sql
-- Pure ASCII. No BEGIN/COMMIT.

-- Superadmin flag
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT FALSE;

-- Audit trail de la signature NDA (renforce la valeur probante)
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS nda_ip        TEXT;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS nda_user_agent TEXT;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS nda_text_hash TEXT;

-- Table bahyo_nda : historique des versions du texte NDA (editable via l'admin)
CREATE TABLE IF NOT EXISTS bahyo_nda (
  id         UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  version    TEXT NOT NULL UNIQUE,
  texte      TEXT NOT NULL,
  actif      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_nda_actif ON bahyo_nda(actif) WHERE actif = TRUE;

-- Definir Francis comme superadmin (a executer apres son inscription)
UPDATE bahyo_user SET is_superadmin = TRUE
WHERE email IN ('francis.portogallo@protonmail.com', 'francis.portogallo@gmail.com');
