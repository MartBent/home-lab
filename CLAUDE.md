# Claude operational notes — home-lab

Context for future Claude sessions working on this repo. Covers things that aren't obvious from reading the code: paths, gotchas, conventions, and operational tricks established by previous sessions.

## Where things live

**Two clones of this repo:**

| Location | Purpose |
|---|---|
| `~/Private/Git/homelab/` on Mart's Mac | Editing, commits, push |
| `~/Git/home-lab/` on the NAS (`<user>@server.home`) | **Authoritative for runtime** — terraform state lives here, docker compose runs here, HA config lives here |

GitHub origin: see `git remote -v` (repo was renamed from `homelab` → `home-lab`; GitHub redirects the old URL, but the canonical name is `home-lab`).

**Two `.env` files (different purposes, don't mix up):**

| Path | Loaded by | Holds |
|---|---|---|
| `~/Git/home-lab/.env` | terraform (via `--env-file`) | `TF_VAR_*` |
| `~/Git/home-lab/docker/my-apps/.env` | docker compose (auto-loaded next to compose file) | MONGO_*, UMAMI_*, APP_*, CLOUDFLARE_TUNNEL_TOKEN, N8N_* |

Both are gitignored. A previous `/volume1/docker/belegtools/.env` existed historically; **don't recreate it** — the consolidation into `docker/my-apps/.env` is intentional.

## Synology NAS specifics

- Hostname `server.home` (resolved via local DNS). If you need the LAN IP for a config decision, look it up at runtime — don't hard-code:
  ```sh
  nslookup server.home              # works on macOS
  getent hosts server.home          # works in alpine/debian
  ```
- SSH: `ssh <user>@server.home` (NAS admin account; key-based auth; no password from Mart's Mac)
- Shell: `/bin/sh` over SSH (POSIX) — not bash. Heredoc + `set -e` work; some bash-isms don't.
- Default SSH `$PATH` is sparse (only `/usr/bin:/bin` style) — **always use absolute paths**:
  - Docker: `/usr/local/bin/docker`
  - Git: `/usr/local/bin/git`
  - Terraform: not installed; runs via `hashicorp/terraform:latest` Docker image
  - Synology Git package can be added with `export PATH="$PATH:/var/packages/Git/target/bin"` but absolute paths are simpler
- `sudo` requires a password — **no elevated commands work over non-interactive SSH**. For root-owned files use the privileged-container trick:
  ```sh
  docker run --rm -v /path:/p alpine rm -rf /p/...
  ```
- The NAS user is in groups `users`, `administrators`, `docker` — so docker works without sudo.
- `/volume1/` is the main btrfs volume (1.8 TB total, ~75 GB used after cleanup). Three user-facing shares: `Shared files/`, `docker/`, `homes/`. Everything else is DSM internal (`@`-prefixed).
- Auto-update package list runs via DSM — don't expect Linux-style `apt` or `dnf`. Synology packages live under `/var/packages/`.

## Architectural split (decided this session)

- **Terraform → Cloudflare only** (tunnel, DNS records, tunnel ingress config)
- **Docker Compose → every container** (no more docker resources in TF)

Don't reintroduce `docker_*` resources in `.tf` files. They were removed from code and state in this session.

## Compose project conventions

The project is `my-apps` (taken from the dir name `docker/my-apps/`). All running container labels show `com.docker.compose.project=my-apps` — that prefix appears on every volume (`my-apps_belegtools_mongodb_data`, etc.).

**Service-name vs container-name split** (intentional, don't "fix"):

| Service (compose key, DNS name on internal net) | container_name |
|---|---|
| `umami` | `belegtools-umami` |
| `umami-db` | `belegtools-umami-db` |

Belegtools' nginx upstream config references `umami` and `umami-db` by DNS — changing service names would break the image without a rebuild. The container_name is just for `docker ps` readability.

**Volume naming:** every belegtools-stack volume is prefixed `belegtools_` (`belegtools_mongodb_data`, `belegtools_umami_db_data`). `n8n_data` is unprefixed because it's a separate stack.

## Cloudflare tunnel mechanics

- Tunnel name: `HomeLab` (managed in TF as `cloudflare_zero_trust_tunnel_cloudflared.this`)
- The **tunnel token and tunnel ID regenerate on `terraform destroy`/`apply`**. Cloudflared's `CLOUDFLARE_TUNNEL_TOKEN` in `docker/my-apps/.env` will go stale. After any destroy/apply:
  ```sh
  NEW=$(terraform output -raw cloudflare_tunnel_token)
  sed -i.bak -E "s|^CLOUDFLARE_TUNNEL_TOKEN=.*|CLOUDFLARE_TUNNEL_TOKEN=$NEW|" docker/my-apps/.env
  docker compose -f docker/my-apps/docker-compose.yml up -d --force-recreate cloudflared
  ```
- Ingress origins use **hostname `server.home`, not the IP** — codified in `TF_VAR_host_local_ip=server.home`. Don't switch back to a raw IP.
- 4 active routes: `<ha_subdomain>.<root_domain>`, `<n8n_subdomain>.<root_domain>`, `<rfid_subdomain>.<root_domain>`, and the `<belegtools_domain>` apex (subdomains + root come from `TF_VAR_*` in `~/Git/home-lab/.env`). Plus catch-all 404.

## Home Assistant gotcha

**`http.trusted_proxies` MUST include the NAS LAN subnet.** Cloudflared runs in `network_mode: host`, so its calls to `http://server.home:8123` appear to HA as coming from the NAS's LAN IP. Without the right trusted_proxies entry, HA returns `400 Bad Request` to every proxied request.

Configure at `~/Git/home-lab/ha/configuration.yaml`:
```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - <LAN subnet of the NAS, e.g. 10.0.0.0/24>
    - 127.0.0.1
```

If you change LAN subnets, this is the file to update — and remember to `docker restart homeassistant` afterward.

The `ha/` directory is **gitignored** — HA's data (DB, backups, custom_components) lives only on the NAS. Don't try to track it under IaC; the repo's role is the compose mount only.

## Terraform workflow

Run via the official image (no local terraform install on the NAS):

```sh
cd ~/Git/home-lab
docker run --rm \
  --env-file "$PWD/.env" \
  -v "$PWD":/workspace -w /workspace \
  hashicorp/terraform:latest <subcommand>
```

State drift to watch for:
- The Cloudflare API auto-adds `origin_request = {}` to ingress entries; TF wants `null`. Harmless idempotent diff after manual UI edits.
- `.terraform.lock.hcl` regularly shows uncommitted hash changes because each TF run uses a fresh container with different platform hashes. Ignore the diff unless you're intentionally bumping the provider.

## Watchtower

Label-only mode (`WATCHTOWER_LABEL_ENABLE=true`). Only these auto-update:
- `rfid-analyzer`
- `belegtools`
- `watchtower` itself

Everything else (HA, n8n, postgres, mongo, cloudflared, umami) is updated manually — by design, to avoid surprise data-layer upgrades.

## Cloudflare CLI access

User has the `cf` shell function in `~/.zshrc` (Mac) that wraps `curl` + 1Password. **Path goes first, then any extra curl flags:**

```sh
cf /zones                                       # RO query (default)
cf /user/tokens/verify                          # confirm token + RO scope
cf --write /zones/<id>/dns_records -X DELETE    # use RW token
cf --write /zones/<id>/dns_records -X POST --data '{...}'
```

The function (for reference / regeneration):

```sh
cf() {
  local item="Cloudflare RO Token"
  case "$1" in
    --write) item="Cloudflare RW Token"; shift ;;
    --read)  shift ;;
  esac
  local token
  # --account value is the user's personal 1P account (run `op account list` to find it)
  token=$(op read --account <op-account> "op://Private/$item/password") || return
  curl -sS -H "Authorization: Bearer $token" -H "Content-Type: application/json" \
    "https://api.cloudflare.com/client/v4$1" "${@:2}"
}
```

Two tokens stored in 1P (personal vault, item names: `Cloudflare RO Token`, `Cloudflare RW Token`). Required scopes on the RW token: Zone DNS Edit + Zone Read + Account Cloudflare Tunnel Edit. Scoped to specific zones (not "All zones").

## SSH access pattern

From Mart's Mac (key-based, no password needed):
```sh
ssh <user>@server.home '...command...'                              # one-shot
ssh <user>@server.home                                              # interactive shell
```

When running NAS commands from Claude, always use absolute paths (`/usr/local/bin/docker`, `/usr/local/bin/git`) — the SSH `$PATH` is sparse. Don't try `cd` then `git` over SSH unless you've explicitly extended `$PATH`.

For long-running NAS commands (terraform apply, image pulls, large copies), redirect to a log file on the NAS and tail it back — direct SSH inheritance of stdout can break under network blips:

```sh
ssh <user>@server.home '
cd ~/Git/home-lab
/usr/local/bin/docker run ... terraform:latest apply -auto-approve > /tmp/tf-apply.log 2>&1
echo "exit=$?"
tail -20 /tmp/tf-apply.log
'
```

Don't hard-code account or zone IDs anywhere — fetch them on demand:
```sh
cf /accounts                  # list account IDs + names
cf /zones                     # list zones (id, name, account)
```
The single active CF account hosts three zones: the primary root domain (HA/n8n/sdr CNAMEs + SimpleLogin MX/DKIM), the belegtools apex domain (CNAME to tunnel), and one empty/unused zone.

## Umami

- App at `http://server.home:3001/` (local-network only, not exposed via tunnel)
- Single user `admin`; password is bcrypt-hashed in DB. Default would be `umami` if never changed.
- Postgres DB lives in volume `my-apps_belegtools_umami_db_data` (renamed from `my-apps_umami_db_data` this session — data migrated cp -a).

## Things historically deleted (don't recreate)

- `/volume1/docker/belegtools/` (compose stayed but `.env` was consolidated, then the whole dir removed)
- `/volume1/docker/homeassistant/` (304 MB — old HA dir, predates the `ha/` repo mount)
- `/volume1/docker/n8n/data` (548 MB orphan bind-mount; container uses docker volume `my-apps_n8n_data`)
- `/volume1/docker/pihole/`, `synology-dashboard/`, `private/`
- `~/${NPM_PACKAGES}/` and `~/%` (home dir cruft from shell-expansion accidents)
- `cloudflare_dns_record.drive_record` resource (the `drive.<root_domain>` record is VPN-only now, not exposed via tunnel)
- `TF_VAR_drive_prefix`, `TF_VAR_docker_host` from `.env` (no longer referenced)

## User preferences (carry these to any session)

- Prefers raw API + curl over CLI wrappers (skipped wrangler/flarectl/cloudflared CLI). Recipe pattern: scoped token in 1Password + shell function.
- Will not weaken macOS security (Gatekeeper, xattrs) to make a binary work. Prefers uninstall over workaround.
- Minimal tooling — fewer global installs, more shell functions that pull secrets on demand.
