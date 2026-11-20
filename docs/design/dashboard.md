# Customer dashboard — design record (Phase 6, increment 2)

Served by the API at `/dashboard` (`apps/dashboard`), built on `@arc/ui` and governed by
[DESIGN.md](../../DESIGN.md). Composed with the design skill at maturity L1 (DESIGN.md): every
screen reuses the console's shell, panels, tables, sheets and dialogs. No new components were
needed; the ARC-key and provider-key flows, the account page and the traffic chart are shared
code in `packages/ui`.

**Design read:** a product dashboard · developers and small teams who bring their own provider
keys · calm, precise, the same "mission control at night" as the console, with more guidance.

## Screens

| Screen        | Route             | Purpose                                                                                                    | Who can act                        |
| ------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Sign in       | `/` (signed out)  | Email + password over the space art                                                                        | Everyone                           |
| Sign up       | `/signup`         | Only when `SIGNUP_MODE=open`; otherwise explains invitations                                               | —                                  |
| Invitation    | `/invite#<token>` | Sign up (new user), sign in then accept (existing user), or explain a wrong/expired link                   | Invitee                            |
| Overview      | `/`               | Get started (4 steps, hidden when done), keys that need attention, usage                                   | Steps' actions: admins             |
| Apps          | `/apps`           | Apps with 24 h requests and error rate; create an app                                                      | Admins create                      |
| App           | `/apps/:id`       | ARC keys (issue, show once, rotate, revoke), "Connect your app" (base URL, key, first request), 24 h usage | Admins manage keys                 |
| Provider keys | `/keys`           | The organization's own keys (BYOK): add and check, details, on/off, replace, delete                        | Admins (members see why not)       |
| Usage         | `/usage`          | Requests, errors, fallbacks, overhead; breakdown by app, provider, model, key                              | Everyone                           |
| Team          | `/team`           | Members and roles, pending invitations, invite by link                                                     | Admins invite; owners change roles |
| Settings      | `/settings`       | Organization name; allowed regions                                                                         | Owners                             |
| Account       | `/account`        | Password and signed-in devices (shared with the console)                                                   | Everyone                           |

The organization sits under the wordmark; people in several organizations switch there (each
switch remounts the app, so no data from the previous organization stays on screen). The
footer states the rule that matters most to customers: requests use only their own keys.

## Decisions

- **Invitation links, not email.** ARC has no transactional email yet (SMTP is for alerts), so an
  invitation creates a link shown once to whoever invites. The token rides in the URL fragment
  and request bodies, so it never reaches a server or proxy log.
- **Sign-up is invitation-only by default** (`SIGNUP_MODE=invite`); `open` lets anyone create an
  organization. Customers can only use their own keys either way.
- **Get started is derived from real state** (keys, apps, an active ARC key, any traffic), not
  stored progress, and disappears once complete.
- **Members can look, not change**: provider keys are admin-only in the API, so the page explains
  that instead of showing an error.

## Accessibility and verification

- axe-core (wcag2a, wcag2aa, best-practice): no violations on any dashboard route, the key sheet,
  the add-key sheet or the invitation dialogs.
- Keyboard: the shared shell (skip link), row links, menus and focus-trapped dialogs from the
  console review apply here unchanged.
- Screens checked at 1440×900 and 390×844 with seeded data (Northwind Analytics: two keys, two
  apps, 30 days of traffic).

## Copy (UX copy pass)

Verb-first actions ("Create link", "Issue key", "Revoke key"), errors that say what to do ("This
invitation has expired or was used. Ask whoever invited you for a new link."), confirmations
named after the action ("Leave Northwind Analytics?"), and one term per thing: **ARC key** (what
apps send to ARC), **provider key** (the organization's own Gemini/Groq/… key).

## Open

- Models found with a customer's key are usable only once the owner has classified them
  (`models.enabled` is global). Whether customers may enable models for their own keys is a
  decision for the owner.
- App-level routing rules exist in the API but aren't in the dashboard yet.
- App users' own keys through ARC (per-user ARC keys) still needs its design approved.
