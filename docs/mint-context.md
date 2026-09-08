# Immutable internal mint context

The Session Worker RPC accepts optional `mintContext`, an opaque UTF-8 string bounded to8192bytes or null. It is inserted in the same synchronous storage transaction as the session and never returned in public HTTP/WebSocket status. Public HTTP mint deliberately does not forward this field. This primitive carries server-owned context; it does not authorize an action or validate private application policy.

The internal `readMintContext()` RPC returns `{sessionId, expiresAt, context}` only for an active unexpired session. Legacy missing metadata reads null and cannot be backfilled. Exact internal mint retries with identical tokens, normalizedTTL and context reuse the immutable deadline; conflicting/expired retries fail. Normal session teardown deletes the context with the rest of its storage. Application mint routes use new random session IDs and must never repurpose a closed session ID.

Private applications must validate their context schema and verified identity, pass it only from their trusted mint route, and expose it only through an independently authenticated server endpoint. No public route or browser request may supply authorization context. Persist-before-notify ensures callbacks see a complete session.

Tests cover rollback on context insertion failure, eviction persistence, concurrent conflicting creation, immutable/null/legacy behavior, UTF-8 size limits, HTTP spoofing and expiry.
