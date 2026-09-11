-- Migration 003 : ln_url sur bahyo_user
-- version 003 | 2026-08-24 | PostgreSQL 9.6+

ALTER TABLE bahyo_user ADD COLUMN IF NOT EXISTS ln_url TEXT;

CREATE INDEX IF NOT EXISTS idx_user_ln_url ON bahyo_user(ln_url) WHERE ln_url IS NOT NULL;
