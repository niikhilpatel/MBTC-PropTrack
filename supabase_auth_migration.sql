-- PropTrack: prepare the existing database for real Supabase Auth.
-- Run this ONCE in Supabase SQL Editor before deploying the new code.
-- This does not delete existing accounts or trades.

alter table if exists public.accounts
  add column if not exists starting_balance numeric default 0,
  add column if not exists reset_time text default '00:00',
  add column if not exists dd_mode text default 'static',
  add column if not exists notes text default '';

-- Backfill starting balance for older accounts that did not have the column.
update public.accounts
set starting_balance = coalesce(starting_balance, account_size)
where starting_balance is null or starting_balance = 0;

-- Keep the custom users table compatible with Supabase Auth user UUIDs.
-- Existing rows are preserved. New authenticated users are inserted by the Netlify function.
