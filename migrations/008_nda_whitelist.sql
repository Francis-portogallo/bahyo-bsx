-- Migration 008 : NDA + whitelist emails
-- version 008 | 2026-08-27 | PostgreSQL 9.6+
-- Depends on 005_account_approval.sql
-- Pure ASCII. No BEGIN/COMMIT.

-- Ajout colonnes NDA sur bahyo_user
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS nda_signed_at TIMESTAMPTZ;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS nda_version   TEXT;

-- Table whitelist : emails autorises sans validation admin ni NDA
-- (typiquement : membres de l'equipe, proches du developpement)
CREATE TABLE IF NOT EXISTS bahyo_whitelist_email (
  id         UUID PRIMARY KEY DEFAULT bahyo_uuid(),
  email      TEXT NOT NULL UNIQUE,
  motif      TEXT,
  ajoute_par TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whitelist_email ON bahyo_whitelist_email(email);

-- Seed admin (a adapter avec la vraie adresse)
INSERT INTO bahyo_whitelist_email (email, motif, ajoute_par)
VALUES
  ('francis.portogallo@protonmail.com', 'Fondateur',           'systeme'),
  ('francis.portogallo@gmail.com',      'Fondateur (Gmail)',   'systeme')
ON CONFLICT (email) DO NOTHING;
