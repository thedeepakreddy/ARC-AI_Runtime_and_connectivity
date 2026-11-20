# ARC — Admin API (control plane)

Base path: `/admin/v1`. Session cookie auth (`arc_session`, HttpOnly, Secure, SameSite=Strict).
Responses are `Cache-Control: no-store`. Errors use one envelope:

```json
{
  "error": {
    "type": "invalid_request_error",
    "code": "invalid_request",
    "message": "…",
    "details": []
  }
}
```

Tenant-scoped routes act on the caller's tenant. Users with several memberships pick one with
the `x-arc-tenant: <tenant-id>` header. Superadmin does **not** bypass tenant isolation.

## Auth

| Method | Path           | Notes                                                    |
| ------ | -------------- | -------------------------------------------------------- |
| POST   | `/auth/login`  | `{ email, password }`; rate-limited per email and per IP |
| GET    | `/auth/me`     | Current user and tenant memberships                      |
| POST   | `/auth/logout` | Revokes the session                                      |

## Catalogue

| Method | Path          | Who        | Notes                                                                                        |
| ------ | ------------- | ---------- | -------------------------------------------------------------------------------------------- |
| GET    | `/providers`  | any user   | Provider catalogue with group, jurisdiction, adapter, `verifiedAt`                           |
| GET    | `/models`     | any user   | `?provider=` `?enabled=`                                                                     |
| POST   | `/models`     | superadmin | Add a model manually (`UNKNOWN`, disabled)                                                   |
| PATCH  | `/models/:id` | superadmin | Capabilities, eligibility (evidence URL required unless `UNKNOWN`), enable (never `UNKNOWN`) |

## Provider keys (multiple per provider)

| Method | Path                                | Notes                                                                          |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------ |
| GET    | `/provider-accounts`                | `?provider=`; returns `secretHint` only, never the key                         |
| POST   | `/provider-accounts`                | `{ providerId, label, apiKey, baseUrl?, enabled? }`; label unique per provider |
| GET    | `/provider-accounts/:id`            |                                                                                |
| PATCH  | `/provider-accounts/:id`            | `{ label?, enabled?, baseUrl? }`                                               |
| PUT    | `/provider-accounts/:id/credential` | Replace the key; old encrypted credential is deleted                           |
| DELETE | `/provider-accounts/:id`            | Deletes the key and its credential                                             |
| POST   | `/provider-accounts/:id/validate`   | Checks the key with the provider; records health and models seen               |

Scope is set by ARC, not the caller: keys in the platform tenant are `owner_private`; keys in
customer tenants are `tenant_byok`. Discovered models arrive as `UNKNOWN` and disabled.

## ARC API keys (for applications)

| Method | Path                            | Notes                                                                 |
| ------ | ------------------------------- | --------------------------------------------------------------------- |
| GET    | `/applications/:appId/api-keys` | Lists keys with `displayPrefix` only                                  |
| POST   | `/applications/:appId/api-keys` | `{ name, scopes?, expiresInDays? }`; response contains `key` **once** |
| POST   | `/api-keys/:id/rotate`          | Issues a replacement (same name/scopes) and revokes the old key       |
| DELETE | `/api-keys/:id`                 | Revokes immediately                                                   |

Keys look like `ARC_DEE_<17-char id>_PAK_<43-char secret>` (256-bit secret, base62). Scopes:
`inference`, `models:read` (default: both).

## Routing

| Method | Path                                  | Who   | Notes                                                                                             |
| ------ | ------------------------------------- | ----- | ------------------------------------------------------------------------------------------------- |
| GET    | `/routing/policy`                     | admin | Tenant-wide policy (defaults: all jurisdictions, no paid owner keys)                              |
| PUT    | `/routing/policy`                     | owner | `{ allowedJurisdictions: [...] \| null, allowPaidOwnerKeys }`                                     |
| GET    | `/applications/:appId/routing-policy` | admin | App override, or `inheritsTenantPolicy: true`                                                     |
| PUT    | `/applications/:appId/routing-policy` | owner | Same body; overrides the tenant policy for that app                                               |
| DELETE | `/applications/:appId/routing-policy` | owner | Back to the tenant policy                                                                         |
| POST   | `/routing/explain`                    | admin | `{ model, applicationId?, capabilities? }` → per-candidate decisions and fallback order (dry run) |

Jurisdictions: `US`, `EU`, `UK`, `CA`, `CN`, `SELF_HOSTED`. `allowPaidOwnerKeys: true` can only
be set by the platform owner.

## Tenant

| Method | Path            | Notes                                                      |
| ------ | --------------- | ---------------------------------------------------------- |
| GET    | `/applications` |                                                            |
| POST   | `/applications` | `{ name, slug, firstParty? }`; first-party = platform only |
| GET    | `/audit-events` | `?limit=` (max 200); metadata only                         |

## Console (platform owner only)

| Method | Path                                   | Notes                                                                                                            |
| ------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| GET    | `/console/overview?range=24h\|7d\|30d` | Services, "needs you" (alerts, failing keys, models to classify, expiring keys), totals, series, by app/provider |
| GET    | `/console/traffic?range=&by=&app=`     | `by`: `app`, `provider`, `model`, `key`; optional `app` id; rows + series                                        |
| GET    | `/console/customers`                   | Customer organizations with members, apps, keys, 30-day requests                                                 |
| POST   | `/console/customers/:id/suspend`       | Their keys stop at once on every instance; `/unsuspend` restores                                                 |

## Account (any signed-in user)

| Method | Path                    | Notes                                                |
| ------ | ----------------------- | ---------------------------------------------------- |
| GET    | `/account/sessions`     | Active sessions; `current` marks this one            |
| DELETE | `/account/sessions/:id` | Sign out that session                                |
| POST   | `/account/password`     | `{ currentPassword, newPassword }`; signs out others |

Also: `PATCH /models/:id` accepts `termsNote` (≤ 500 chars, restricted-free terms);
`POST /api-keys/:id/rotate` accepts `{ overlapMinutes: 0 | 60 | 1440 }` (the old key keeps working
that long, then expires).

## Customers: sign-up, invitations, team, usage

Invitation tokens (`arci_…`) are shown once, stored as SHA-256, and always sent in request
bodies; dashboard links carry them in the URL fragment (`/dashboard/invite#arci_…`), which
browsers never send to a server. One use, 7 days, only for the invited email.

| Method | Path                        | Who             | Notes                                                                                 |
| ------ | --------------------------- | --------------- | ------------------------------------------------------------------------------------- |
| GET    | `/auth/config`              | Anyone          | `{ signup: "invite" \| "open" }` (`SIGNUP_MODE`)                                      |
| POST   | `/auth/invitations/preview` | Anyone          | `{ token }` → email, role, organization, `newOrganization`; throttled                 |
| POST   | `/auth/signup`              | Anyone          | `{ email, password, organization?, inviteToken? }`; creates user, membership, session |
| POST   | `/auth/invitations/accept`  | Signed in       | `{ token, organization? }` for an existing user; email must match                     |
| GET    | `/tenant`                   | Member          | The organization and your role                                                        |
| PATCH  | `/tenant`                   | Owner           | `{ name }`                                                                            |
| GET    | `/usage?range=&by=&app=`    | Member          | Like `/console/traffic`, only this tenant's traffic                                   |
| GET    | `/members`                  | Member          | Members with role and last sign-in; `you` marks yourself                              |
| PATCH  | `/members/:userId`          | Owner           | `{ role }`; the last owner can't be demoted                                           |
| DELETE | `/members/:userId`          | Admin (or self) | Removing an owner needs owner; the last owner can't leave                             |
| GET    | `/invitations`              | Admin           | Pending invitations                                                                   |
| POST   | `/invitations`              | Admin           | `{ email, role }` → includes `token` once; only owners invite owners                  |
| DELETE | `/invitations/:id`          | Admin           | Revoke                                                                                |
| GET    | `/console/invitations`      | Platform owner  | Pending invitations for new customers                                                 |
| POST   | `/console/invitations`      | Platform owner  | `{ email }` → a link that creates a new organization owned by them                    |
| DELETE | `/console/invitations/:id`  | Platform owner  | Revoke                                                                                |

## Account security

One-time tokens (`arcr_…` reset, `arcv_…` confirm, `arcm_…` second step) are single-use,
short-lived and stored as SHA-256; email links carry them in the URL fragment.

| Method | Path                            | Who       | Notes                                                                                             |
| ------ | ------------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| POST   | `/auth/login`                   | Anyone    | `{ ok: true }`, or `{ mfaRequired: true, mfaToken }` when two-step sign-in is on (no session yet) |
| POST   | `/auth/login/mfa`               | Anyone    | `{ mfaToken, code }`: a TOTP or recovery code; 5 tries per challenge, each TOTP code once         |
| POST   | `/auth/password-reset/request`  | Anyone    | `{ email, app }` → always 202 (never says whether the account exists); 501 without email          |
| POST   | `/auth/password-reset/complete` | Anyone    | `{ token, newPassword }`; signs out every session                                                 |
| POST   | `/auth/verify-email`            | Anyone    | `{ token }` from the confirmation email                                                           |
| POST   | `/auth/verify-email/send`       | Signed in | Send the confirmation email again                                                                 |
| POST   | `/auth/google/start`            | Anyone    | `{ app, inviteToken?, organization? }` → `{ url }` (PKCE; state kept server-side)                 |
| GET    | `/auth/google/callback`         | Google    | Redirects to `/<app>/#google=<result>` or `#mfa=<token>`                                          |
| GET    | `/account/security`             | Signed in | Two-step status, recovery codes left, email confirmed, Google linked                              |
| POST   | `/account/mfa/setup`            | Signed in | New secret + `otpauth://` URL (pending until confirmed)                                           |
| POST   | `/account/mfa/enable`           | Signed in | `{ code }` → on, with 10 recovery codes (shown once)                                              |
| POST   | `/account/mfa/recovery-codes`   | Signed in | `{ code }` → a fresh set; the old ones stop working                                               |
| POST   | `/account/mfa/disable`          | Signed in | `{ password, code }`                                                                              |

Creating apps, ARC keys and provider keys needs a confirmed email (`403 email_unverified`).
