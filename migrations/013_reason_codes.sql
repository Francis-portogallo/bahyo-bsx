-- Migration 013 : motifs de suspension/fermeture normalises + liberation email
-- version 013 | 2026-08-27 | PostgreSQL 9.6+
-- Depends on 011_users_management.sql
-- Pure ASCII. No BEGIN/COMMIT.

-- Codes de motifs (normalises)
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS suspended_reason_code TEXT;
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS closed_reason_code    TEXT;

-- Email original avant fermeture (pour audit + eventuelle re-inscription)
ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS closed_original_email TEXT;

-- Contrainte : codes autorises
ALTER TABLE bahyo_user DROP CONSTRAINT IF EXISTS check_suspended_reason_code;
ALTER TABLE bahyo_user ADD CONSTRAINT check_suspended_reason_code CHECK (
  suspended_reason_code IS NULL OR suspended_reason_code IN (
    'NON_RESPECT_NDA',
    'ABUS_PLATEFORME',
    'CONTENU_INAPPROPRIE',
    'ATTEINTE_A_AUTRUI',
    'ENQUETE_EN_COURS',
    'DEMANDE_UTILISATEUR',
    'AUTRE'
  )
);
ALTER TABLE bahyo_user DROP CONSTRAINT IF EXISTS check_closed_reason_code;
ALTER TABLE bahyo_user ADD CONSTRAINT check_closed_reason_code CHECK (
  closed_reason_code IS NULL OR closed_reason_code IN (
    'DEMANDE_UTILISATEUR',
    'NON_RESPECT_NDA',
    'FRAUDE',
    'USAGE_MALVEILLANT',
    'INACTIVITE_PROLONGEE',
    'DOUBLE_COMPTE',
    'AUTRE'
  )
);

-- Autorisations
GRANT SELECT, INSERT, UPDATE, DELETE ON bahyo_user TO qiyo9734_postgres;
