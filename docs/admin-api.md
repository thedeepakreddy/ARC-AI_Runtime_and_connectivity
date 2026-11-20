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
