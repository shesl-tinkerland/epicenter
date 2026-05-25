# SSH Keys and HTTPS Git

SSH feels more mysterious than it is because it has two names for the same idea.

There is the protocol:

```txt
ssh user@server.example.com
```

And there are SSH keys:

```txt
~/.ssh/github_ed25519
~/.ssh/github_ed25519.pub
```

The protocol is how your computer talks to another computer. The key is how your computer proves, "this request is really coming from this machine."

For GitHub, you can usually choose either SSH or HTTPS. Neither choice makes you more serious as a developer. They are just two different auth models.

## The `.ssh` folder

On Unix-like systems, `~` means your home folder. The `.ssh` folder is where SSH tools look for configuration, host records, and keys.

It usually contains files like this:

```txt
~/.ssh/
  config
  known_hosts
  github_ed25519
  github_ed25519.pub
```

`config` is the routing table. It says which username, hostname, and key to use for a given host.

`known_hosts` is a local memory of servers you have connected to before. It helps SSH notice if `github.com` or a server suddenly presents a different machine identity than the one you previously trusted.

Files ending in `.pub` are public keys. These are safe to upload to services like GitHub.

Files without `.pub` are usually private keys. These are secrets. Do not paste them into chat, commit them, email them, or put them in a URL.

## What `id_ed25519` means

`id_ed25519` is just the default filename for an Ed25519 SSH private key.

This command creates an Ed25519 key:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519
```

The key type comes from `-t ed25519`. The filename comes from `-f ~/.ssh/id_ed25519`.

That means the name is flexible. These are all valid names:

```txt
~/.ssh/id_ed25519
~/.ssh/github_ed25519
~/.ssh/work_ed25519
~/.ssh/personal_server_ed25519
```

The computer does not care much about the name. Humans do. A name like `github_ed25519` is nicer than `id_ed25519` because it tells you what the key is for.

## The key pair

An SSH key is a pair:

```txt
private key: ~/.ssh/github_ed25519
public key:  ~/.ssh/github_ed25519.pub
```

The private key stays on your laptop.

The public key goes to the service you want to access.

For GitHub:

```txt
Your laptop
  private key
  public key

GitHub
  public key
```

When you connect, GitHub sends a challenge. Your laptop signs that challenge with the private key. GitHub checks the signature with the public key.

The nice part is that your private key never needs to leave your laptop.

## HTTPS Git

HTTPS Git looks like this:

```txt
https://github.com/owner/repo.git
```

With HTTPS, Git usually authenticates through a credential manager, GitHub CLI, a browser login, or a token stored in the operating system keychain.

On macOS, a common setup is:

```txt
Git remote:          https://github.com/owner/repo.git
Credential storage: macOS Keychain
```

This is a perfectly good default. It is easy to understand, plays well with SSO, and avoids managing SSH keys for GitHub at all.

## SSH Git

SSH Git looks like this:

```txt
git@github.com:owner/repo.git
```

With SSH, GitHub trusts a public key that you added to your GitHub account. Your laptop proves it has the matching private key.

This is convenient when you work across many repos, use scripts, or want auth tied to a specific machine instead of a browser session.

A GitHub-specific SSH config might look like this:

```sshconfig
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_ed25519
  IdentitiesOnly yes
```

That says: when connecting to `github.com`, use the `git` user and this specific key.

## One key or many?

Zero keys is fine if you only use HTTPS and never SSH into servers.

One key per device is common. It says, "this laptop can access the services that have this public key."

Multiple keys per device can be cleaner. It lets you separate purposes:

```txt
~/.ssh/github_ed25519
~/.ssh/work_server_ed25519
~/.ssh/personal_vps_ed25519
```

The benefit is blast-radius control. If you stop using GitHub SSH, you can remove only the GitHub key. If you leave a job, you can remove only the work key. If a server key gets messy, it does not affect GitHub.

## A good default plan

For most people, this is a calm setup:

```txt
GitHub: HTTPS
Servers: SSH only when needed
Keys: named by purpose
```

So GitHub repos use:

```txt
https://github.com/owner/repo.git
```

And SSH keys are created only when there is a specific host that needs one:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/my_server_ed25519 -C "my server"
```

Then `~/.ssh/config` points that host at that key:

```sshconfig
Host my-server
  HostName server.example.com
  User braden
  IdentityFile ~/.ssh/my_server_ed25519
  IdentitiesOnly yes
```

## What to avoid

Do not put tokens in Git remote URLs:

```txt
https://user:token@github.com/owner/repo.git
```

That turns a secret into local configuration text. It can show up in terminal output, scripts, screenshots, logs, backups, and bug reports.

Prefer a normal HTTPS remote:

```txt
https://github.com/owner/repo.git
```

Then let the credential manager store the secret outside the URL.

Also avoid a catch-all SSH config that points every host at one generic key unless you really mean it:

```sshconfig
Host *
  IdentityFile ~/.ssh/id_ed25519
```

That makes the key feel global. Purpose-specific host blocks are easier to reason about later.

## The simple rule

Use HTTPS for GitHub unless you have a reason to use SSH.

Use SSH for servers, machines, and workflows where machine identity is the point.

If you do use SSH keys, name them after their purpose:

```txt
github_ed25519
work_ed25519
personal_server_ed25519
```

The point is not to collect keys. The point is to keep authentication understandable enough that future you can look at `~/.ssh` and immediately know what is still alive.
