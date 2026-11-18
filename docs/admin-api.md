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

## Tenant

| Method | Path            | Notes                                                      |
| ------ | --------------- | ---------------------------------------------------------- |
| GET    | `/applications` |                                                            |
| POST   | `/applications` | `{ name, slug, firstParty? }`; first-party = platform only |
| GET    | `/audit-events` | `?limit=` (max 200); metadata only                         |
