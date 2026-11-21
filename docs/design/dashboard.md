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
| Sign up       | `/signup`         | "Create your account": Google, or email + password; team name optional. Only when `SIGNUP_MODE=open`       | —                                  |
| Invitation    | `/invite#<token>` | Sign up (new user), sign in then accept (existing user), or explain a wrong/expired link                   | Invitee                            |
| Overview      | `/`               | Get started (4 steps, hidden when done), keys that need attention, usage                                   | Steps' actions: admins             |
| Apps          | `/apps`           | Apps with 24 h requests and error rate; create an app                                                      | Admins create                      |
| App           | `/apps/:id`       | ARC keys (issue, show once, rotate, revoke), "Connect your app" (base URL, key, first request), 24 h usage | Admins manage keys                 |
| Provider keys | `/keys`           | The organization's own keys (BYOK): add and check, details, on/off, replace, delete                        | Admins (members see why not)       |
| Usage         | `/usage`          | Requests, errors, fallbacks, overhead; breakdown by app, provider, model, key                              | Everyone                           |
| Playground    | `/playground`     | Try chat, speech, transcription and images with a pasted ARC key; shows the route taken                    | Everyone with a key                |
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

## Sign-up without naming an organization

Every customer's apps, keys and usage belong to an organization, so teams can share them. A
person signing up alone shouldn't have to invent one: the team name is optional, and without it
ARC creates "<Name>'s workspace" (from the email, renamable in Settings). Google sign-up works the
same way.

## Since

- Models page: customers choose which models their own keys use (decided by the owner).
- End users' own keys go through ARC via `/v1/user-keys` (see inference-api.md).

- Playground (Phase 7): the key is held in the tab only; results show which model answered,
  attempts, fallback and ARC's overhead. axe-core: no violations on every tab; checked at
  1440×900 and 390×844 (tabs wrap on phones). File inputs got a pill picker matching the buttons.

## Open

- Nothing outstanding for the dashboard itself. (App regions: each app's page, since Phase 6.)
