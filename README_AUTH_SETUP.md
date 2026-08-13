# PropTrack — Original UI + Real Supabase Auth

This version keeps the existing PropTrack UI and replaces the old device-based cloud identity with real Supabase Authentication.

## 1. Supabase
Open your existing MBTC PropTrack project.

### Run the migration
Open **SQL Editor → New query**, paste the contents of:

`supabase_auth_migration.sql`

and click **Run**.

Do not delete the existing `users`, `sessions`, `accounts`, or `trades` tables.

### Email authentication
Open **Authentication → Providers → Email** and make sure Email is enabled.

For this first version, email confirmation can remain disabled because the backend creates users with email confirmed. You can enable a stricter confirmation flow later.

## 2. Netlify environment variables
Keep these existing variables:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Add one new variable:

- `SUPABASE_PUBLISHABLE_KEY` = the `sb_publishable_...` key from Supabase Settings → API Keys.

Never put the service-role/secret key in browser code or GitHub.

## 3. Deploy
Replace the files in your existing GitHub repository with this ZIP's files. Netlify should automatically deploy.

## 4. First login / data migration
The first time the user logs in, the app attempts to claim data belonging to the old device-based session. If no old cloud data exists, it uploads the current local backup to the new authenticated account.

## 5. Incognito test
Open the Netlify URL in Incognito, log in with the same email/password, and the same accounts/trades should load from Supabase.
