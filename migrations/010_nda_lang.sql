-- Migration 010 : NDA multilingue (FR + EN)
-- version 010 | 2026-08-27 | PostgreSQL 9.6+
-- Depends on 009_superadmin_audit.sql
-- Pure ASCII. No BEGIN/COMMIT.

-- Ajout colonne lang (defaut 'fr' pour la retrocompatibilite)
ALTER TABLE bahyo_nda ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'fr';

-- Un couple (version, lang) devient unique (a la place de version seule)
ALTER TABLE bahyo_nda DROP CONSTRAINT IF EXISTS bahyo_nda_version_key;
ALTER TABLE bahyo_nda ADD CONSTRAINT bahyo_nda_version_lang_key UNIQUE (version, lang);

-- Index pour retrouver la version active par langue rapidement
DROP INDEX IF EXISTS idx_nda_actif;
CREATE INDEX IF NOT EXISTS idx_nda_actif_lang ON bahyo_nda(lang, actif) WHERE actif = TRUE;

-- Autorisation
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_nda TO qiyo9734_postgres;
