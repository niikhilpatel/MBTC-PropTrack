# PropTrack Cloud — Netlify + Supabase

1. Create a Supabase project.
2. In Supabase SQL Editor, run `supabase_schema.sql`.
3. Deploy this folder to Netlify.
4. In Netlify Environment Variables add:
   - `SUPABASE_URL` = your Supabase project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service-role key
5. Redeploy.

The service-role key must stay in Netlify environment variables and must never be placed in browser JavaScript.

This version provides cloud login, cloud accounts and cloud trades. The frontend remains normal HTML/CSS/JS and the backend uses a Netlify Function.
