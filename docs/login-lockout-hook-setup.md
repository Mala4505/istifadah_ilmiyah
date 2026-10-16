# Turn on the login lockout (Supabase Auth hook) — plain steps

**What it does:** after 10 wrong passwords on one account within 15 minutes, Supabase itself refuses every
further sign-in for that account (even with the right password) until the 15 minutes have passed. It cannot be
skipped by someone who bypasses the website's login form. It never locks an account permanently.

## Read this first: it needs a paid Supabase plan

According to Supabase's documentation (Authentication → Auth Hooks), the **Password Verification Attempt**
hook is available on the **Team** and **Enterprise** plans only. It is not on Free or Pro. Team is roughly
US$599 per month at the time of writing; check Dashboard → Settings → Billing for the real current price
and for your current plan.

If the project is not on Team, the Hooks page will not let you switch this hook on. In that case do not go
further, tell the developer, and decide together whether to pay for Team or use a different protection (for
example Auth CAPTCHA, which is free but a different choice from the one made on 2026-10-15). The database
function in this repo is harmless when the hook is not switched on.

## Before you start (developer does this)

The migration `supabase/migrations/20261015120000_login_lockout_hook.sql` must already be applied to the live
database (the developer runs `npx supabase db push` after asking you). Without it the function you pick in
step 5 will not appear in the list.

## Steps

1. Open the Supabase dashboard in your browser and sign in.
2. Click the project **Istifadah Ilmiyah** (the live one).
3. In the left-hand menu click **Authentication**.
4. Under Authentication, click **Hooks** (it may be labelled "Auth Hooks"). If you cannot see it, look in the
   second list of the left menu, or use the search box at the top.
5. Find the card called **Password Verification Attempt** and click **Add hook** (or the "+" / "Enable"
   button on that card). If the card says "Upgrade" or shows a lock, you are not on the Team plan. See the
   section above and stop.
6. For **Hook type** choose **Postgres function**.
7. For **Postgres Schema** choose `public`.
8. For **Postgres function** choose `hook_password_verification_attempt`. If it is not in the list, the
   migration has not been applied yet. Ask the developer.
9. Click **Create** (or **Save**). The card should now show as enabled.

## Check that it works (5 minutes, use a test account, not a real person)

1. Ask the developer for a test account, or create one in the app.
2. On the login page type the correct ITS number with a wrong password 10 times.
3. On the 11th try use the **correct** password. You should be refused with "Too many attempts. Try again in
   15 minutes." (or the site's own "Too many failed attempts" message, whichever fires first).
4. Wait 15 minutes. The correct password should work again.

## If something goes wrong

- Nobody can log in at all: Authentication → Hooks → click the hook → **Disable** (or delete) it. Logins
  return to normal immediately. Tell the developer.
- A real user is locked out: they only need to wait 15 minutes. Nothing else to do.
- The hook is built to let sign-in continue if it hits an internal error, so a bug in it should not lock
  everyone out.
