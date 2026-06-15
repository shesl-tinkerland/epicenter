---
'@epicenter/auth': minor
'@epicenter/cli': patch
---

Make the framework-agnostic auth runtime publishable by moving its API and OAuth defaults into the auth package, dropping the private `@epicenter/constants` runtime dependency, and re-enabling the CLI publish path now that its auth closure is public.
