# Native TypeScript Is Not a Plugin Sandbox

WebAssembly, workers, import allowlists, and JS compartments are all useful tools. None of them turn copied `daemon.ts` files into hostile-code-safe plugins. If Epicenter imports TypeScript with Bun, that code is native local code running as the user.

```txt
workspaces/fuji/daemon.ts
  |
  v
Bun dynamic import
  |
  v
top-level TypeScript executes as the OS user
```

That is the line. Once the app is native TypeScript, the sandbox conversation has mostly already been decided.

## WebAssembly only helps if the app is actually WebAssembly

Wasm can be a real isolation boundary when the plugin is a Wasm module and the host chooses every import.

```txt
Wasm plugin:
  cannot read files unless host imports readFile
  cannot open sockets unless host imports network
  cannot access secrets unless host passes them in
```

That is not the current workspace app model.

```txt
Current model:
  jsrepo copies TypeScript
  Bun imports TypeScript
  daemon.ts opens real local resources
```

You could design a future Epicenter plugin ABI around Wasm. That would be a different product. No arbitrary `daemon.ts`, no direct Bun imports, no normal package code running with ambient authority.

## Workers and JS realms are lifecycle tools, not security boundaries

Workers are useful for CPU isolation, cancellation, and keeping a slow task away from the UI thread. They are not a permission model.

```txt
Worker gives:
  separate event loop
  message boundary
  easier teardown

Worker does not give:
  no filesystem access
  no network access
  no subprocess access
  hostile-code containment
```

Raw JS `vm` contexts and realms have the same problem. They can create a different global object. They do not create an operating-system boundary, and they do not make native runtime APIs safe by default.

SES compartments are more serious. They can evaluate JavaScript with selected endowments after lockdown. That could work for narrow pure-JS plugins, especially if the host owns every module they can import.

```txt
SES-shaped plugin:
  host provides safe imports
  plugin receives explicit endowments
  no ambient authority by default
```

But again, that is not copied TypeScript imported by Bun. It is a different execution model.

## Import allowlists are review tools

An import allowlist can still be worth having. It can catch mistakes and make reviews faster.

```txt
Flag imports like:
  node:fs
  node:child_process
  bun:*
  process.env
  native addons
  FFI
  unexpected network clients
```

That is useful hardening. It is not containment. A clever attacker can route around lint rules once their code is running with ambient local authority.

The honest label is:

```txt
lint = review aid
runtime flags = hardening
Wasm or SES = possible future plugin ABI
Bun-imported TypeScript = trusted source code
```

## The clean break is to stop pretending

Epicenter can choose trusted local automation and still be serious about safety. The mistake would be to describe native TypeScript workspace apps as sandboxed because they have a manifest, run in a worker, avoid a few imports, or load from `/apps/<route>/`.

```txt
If app code is TypeScript imported by Bun:
  trust the source
  review the diff
  pin the install source
  grant capabilities deliberately

If app code must be hostile-code-safe:
  design a new plugin ABI
  use Wasm or SES
  remove arbitrary daemon.ts
  make the host own every authority
```

Those are both coherent systems. Mixing them creates fake safety. Native workspace apps should be documented as trusted source recipes. Future sandboxed plugins should be a separate thing with a separate contract.
