# Workspace Apps Share One Origin on Purpose

Folder-routed workspace apps do not need a new port for every app. They can live under one daemon origin, move together, and still be opened as separate desktop windows. The path chooses the app; the origin chooses the local workspace host.

```txt
http://127.0.0.1:43821/apps/fuji/
http://127.0.0.1:43821/apps/opensidian/
http://127.0.0.1:43821/apps/honeycrisp/
```

Those are three apps, but they are one browser origin:

```txt
origin = scheme + host + port

origin:
  http://127.0.0.1:43821

paths:
  /apps/fuji/
  /apps/opensidian/
  /apps/honeycrisp/
```

That is not an accident. The daemon is the local workspace host. The apps are not random websites that happen to share a domain; they are local workspace surfaces served by the same runtime.

## Different paths are not different sandboxes

SvelteKit can build an app for a subpath with `paths.base`.

```js
const config = {
	kit: {
		paths: {
			base: '/apps/fuji',
		},
	},
};
```

That makes links and assets work when Fuji is served from `/apps/fuji/`. It does not isolate Fuji from Opensidian. Browser origin isolation does not care about the path.

```txt
What paths.base does:
  /_app/immutable/... becomes /apps/fuji/_app/immutable/...
  links resolve under /apps/fuji/

What paths.base does not do:
  create a new origin
  isolate localStorage
  isolate cookies
  block same-origin requests
```

If we wanted browser-level isolation between apps, each app would need a different origin.

```txt
Fuji:
  http://127.0.0.1:43821/

Opensidian:
  http://127.0.0.1:43822/

Daemon API:
  http://127.0.0.1:43820/
```

That buys isolation, but it also buys port allocation, CORS, token plumbing, service discovery, window lifecycle coordination, and a more complicated mental model. For a system whose install unit is trusted source code, that complexity is not free.

## The desktop shell can open apps without giving each one a server

The clean desktop shape is a shell that knows how to install, build, start, and open workspace apps.

```txt
Epicenter desktop shell
  |
  | install source into workspaces/fuji/
  | build static app
  | start daemon runtime
  v

open window:
  /apps/fuji/
```

The same shell can open another window for another app.

```txt
Main window:
  /apps/

Fuji window:
  /apps/fuji/

Opensidian window:
  /apps/opensidian/
```

Tauri fits this model. A Tauri app can create multiple windows and webviews, and those windows can load different local app URLs. The important part is not that every window gets a separate origin. The important part is that host privileges are mediated by capabilities.

```txt
window label: fuji
loaded URL:   /apps/fuji/

allowed capabilities:
  fuji entries actions
  Fuji-specific file previews

not allowed:
  Opensidian actions
  shell access
  arbitrary filesystem access
```

The browser origin says where the page came from. The capability system says what the page may do.

## One origin keeps the product easier to explain

The folder-routed model has one sentence:

```txt
Every folder under workspaces/ is a local app package.
```

The serving model should be just as small:

```txt
The daemon serves built app bundles under /apps/<route>/.
```

That gives us one local host, one app launcher, one routing scheme, and one place to hang future desktop behavior.

```txt
Project/
  workspaces/
    fuji/
      daemon.ts
      workspace.ts
      build/

Daemon:
  /apps/fuji/ -> workspaces/fuji/build/
```

Separate ports are a good answer when apps are untrusted. Epicenter's first workspace apps are not that. They are editable source packages the user chose to install into a project. For that model, one origin is a feature: the apps feel like parts of the same local workspace rather than unrelated web servers.

The security boundary should move to the thing we actually care about: capabilities. Static app serving can stay simple. Privileged host access should be explicit, route-aware, and reviewable.
