# PropTrack — Original UI + Cloud Sync

This package keeps the original PropTrack v2 UI and adds Supabase cloud persistence through a Netlify Function. The Cancel button in New Trade is preserved.

## Netlify environment variables
Add these two variables before deploying:
- `SUPABASE_URL` = your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service-role secret key

Never put the service-role key inside `index.html` or `app.js`.

## Supabase schema
Use the `users`, `sessions`, `accounts`, and `trades` tables already created in your project. The function creates a device-scoped user/session automatically and syncs accounts/trades.

## Data behavior
- LocalStorage is used as a fast local cache.
- Supabase is the cloud copy.
- On first connection, existing local accounts/trades are uploaded if the cloud account has no data.
- Later changes sync to Supabase.
- The original dashboard layout is retained.
