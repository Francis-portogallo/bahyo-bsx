-- Migration 007 : ajout LINKEDIN_URL et INSTAGRAM_URL a la contrainte CHECK
-- version 007 | 2026-08-25 | PostgreSQL 9.6+
-- Depends on 006_source_types.sql
-- Pure ASCII. No BEGIN/COMMIT.

ALTER TABLE bahyo_source DROP CONSTRAINT IF EXISTS bahyo_source_type_check;

ALTER TABLE bahyo_source ADD CONSTRAINT bahyo_source_type_check
  CHECK (type IN (
    'FICHIER', 'URL', 'TEXTE_LIBRE',
    'LINKEDIN_ZIP', 'LINKEDIN_PDF', 'LINKEDIN_JSON', 'LINKEDIN_URL',
    'INSTAGRAM_ZIP', 'INSTAGRAM_URL',
    'CV_PDF', 'CV_DOCX',
    'CERTIFICATION',
    'ARCHIVE_ZIP',
    'AUTRE'
  ));
