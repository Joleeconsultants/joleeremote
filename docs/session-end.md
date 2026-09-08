# End an owned session

Send `POST /sessions/{sessionId}/end` with `Authorization: Bearer <browserToken>`.
The exact session's browser token is required. Agent tokens, tokens from other
sessions, query tokens, and GET requests do not authorize ending a session.
Product deployments must retain their existing operator authentication around
this route; the Jolee Remote private wrapper keeps its Access gate.

A 204 response means the hop finished its existing teardown: both sockets are
closed, pending file requests fail, stored session data is removed, and old joins
are rejected. This removes session files just like expiry or agent departure.
It does not independently prove native process exit or Windows button release.
Missing credentials return 401, wrong-role/session tokens 403, and a missing or
already-ended session 404. An expired retained session can still be ended by its
own browser token. Responses are not cached. Do not send tokens in URLs or logs.

This is an explicit API action. Browser refresh/closure continues to allow
reconnection until expiry or agent departure. No visual UI changes are included.
