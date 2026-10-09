# Claude operational notes, home-lab

Context for future Claude sessions on this repo. Covers what you can't get from reading the code: paths, gotchas, conventions, and tricks earlier sessions worked out.

## Where things live

Two clones of this repo:

| Location | Purpose |
|---|---|
| `~/Private/Git/homelab/` on Mart's Mac | editing, commits, push |
| `~/Git/home-lab/` on the NAS (`<user>@server.home`) | **authoritative for runtime.** Terraform state lives here, compose runs here, HA config lives here |

GitHub origin: see `git remote -v`. The repo was renamed `homelab` to `home-lab`; GitHub redirects the old URL but `home-lab` is the canonical name.

Two `.env` files, easy to confuse:

| Path | Loaded by | Holds |
|---|---|---|
| `~/Git/home-lab/.env` | terraform, via `--env-file` | `TF_VAR_*` |
| `~/Git/home-lab/docker/my-apps/.env` | docker compose, auto-loaded next to the compose file | `CLOUDFLARE_TUNNEL_TOKEN`, `N8N_*`, `GHCR_*` |

Both are gitignored. A `/volume1/docker/belegtools/.env` existed historically. Don't recreate it, the consolidation into `docker/my-apps/.env` was deliberate.

Two Home Assistant directories, also easy to confuse:

| Path | Tracked? | What it is |
|---|---|---|
| `homeassistant/` | yes | sources worth version control: theme, dashboards, automations. See its README for deploy steps |
| `ha/` | no | the live `/config` the container mounts, NAS only: database, backups, custom_components |

## Synology NAS specifics

- Hostname `server.home`, resolved over local DNS. Need the LAN IP for a config decision? Look it up at runtime, don't hard-code it:
  ```sh
  nslookup server.home              # macOS
  getent hosts server.home          # alpine/debian
  ```
- SSH: `ssh <user>@server.home`. NAS admin account, key-based, no password from Mart's Mac.
- The SSH shell is `/bin/sh` (POSIX), not bash. Heredoc and `set -e` work, some bash-isms don't.
- The default SSH `$PATH` is sparse, so always use absolute paths:
  - docker: `/usr/local/bin/docker`
  - git: `/usr/local/bin/git`
  - terraform: not installed, runs from the `hashicorp/terraform:latest` image
  - the Synology Git package can be added with `export PATH="$PATH:/var/packages/Git/target/bin"`, but absolute paths are simpler
- `sudo` needs a password, so no elevated command works over non-interactive SSH. For root-owned files, use a privileged container:
  ```sh
  docker run --rm -v /path:/p alpine rm -rf /p/...
  ```
- The NAS user is in `users`, `administrators`, `docker`, so docker needs no sudo.
- `/volume1/` is the main btrfs volume, 1.8 TB total. Three user-facing shares: `Shared files/`, `docker/`, `homes/`. Everything else is DSM internal, `@`-prefixed.
- Package updates run through DSM. There is no `apt` or `dnf`; Synology packages live under `/var/packages/`.

## Architectural split

Terraform touches Cloudflare only: tunnel, DNS records, tunnel ingress config. Compose owns every container. Don't reintroduce `docker_*` resources in the `.tf` files, an earlier session pulled them out of both the code and the state.

## Compose project conventions

The project name is `my-apps`, taken from the `docker/my-apps/` directory name. Every container label shows `com.docker.compose.project=my-apps`, and that prefix lands on every volume (`my-apps_n8n_data`).

## Cloudflare tunnel mechanics

- Tunnel name `HomeLab`, managed as `cloudflare_zero_trust_tunnel_cloudflared.this`.
- The tunnel token and tunnel ID regenerate on every `terraform destroy` + `apply`, which leaves `CLOUDFLARE_TUNNEL_TOKEN` in `docker/my-apps/.env` stale. After any destroy/apply:
  ```sh
  NEW=$(terraform output -raw cloudflare_tunnel_token)
  sed -i.bak -E "s|^CLOUDFLARE_TUNNEL_TOKEN=.*|CLOUDFLARE_TUNNEL_TOKEN=$NEW|" docker/my-apps/.env
  docker compose -f docker/my-apps/docker-compose.yml up -d --force-recreate cloudflared
  ```
- Ingress origins use the hostname `server.home`, not the IP, pinned by `TF_VAR_host_local_ip=server.home`. Don't switch back to a raw IP.
- Four active routes, all subdomains of the root domain: `<ha_subdomain>`, `<n8n_subdomain>`, `<rfid_subdomain>`, `<echo_subdomain>`. Prefixes come from `TF_VAR_*` in `~/Git/home-lab/.env`. Plus a catch-all 404.

## Home Assistant gotcha

`http.trusted_proxies` must include the NAS LAN subnet. Cloudflared runs in `network_mode: host`, so its calls to `http://server.home:8123` reach HA from the NAS's own LAN IP. Get this wrong and HA answers `400 Bad Request` to every proxied request.

Configure at `~/Git/home-lab/ha/configuration.yaml`:
```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - <LAN subnet of the NAS, e.g. 10.0.0.0/24>
    - 127.0.0.1
```

Change LAN subnets and this is the file to update, then `docker restart homeassistant`.

`ha/` is gitignored. HA's data (database, backups, custom_components) lives only on the NAS. Don't try to bring it under IaC; this repo's job there is the compose mount and the sources in `homeassistant/`.

## Terraform workflow

Run from the official image, nothing is installed on the NAS:

```sh
cd ~/Git/home-lab
docker run --rm \
  --env-file "$PWD/.env" \
  -v "$PWD":/workspace -w /workspace \
  hashicorp/terraform:latest <subcommand>
```

Two kinds of drift to expect:
- The Cloudflare API adds `origin_request = {}` to ingress entries; TF wants `null`. A harmless idempotent diff after manual edits in the UI.
- `.terraform.lock.hcl` keeps showing hash changes because each run uses a fresh container with different platform hashes. Ignore it unless you're bumping the provider on purpose.

## Watchtower

Label-only mode (`WATCHTOWER_LABEL_ENABLE=true`). Only `rfid-analyzer` and watchtower itself auto-update. HA, n8n, and cloudflared are updated by hand, deliberately, so no data-layer upgrade lands unannounced.

## Cloudflare CLI access

Mart has a `cf` shell function in `~/.zshrc` on the Mac wrapping `curl` and 1Password. Path first, extra curl flags after:

```sh
cf /zones                                       # read-only query (default)
cf /user/tokens/verify                          # confirm token and scope
cf --write /zones/<id>/dns_records -X DELETE    # uses the RW token
cf --write /zones/<id>/dns_records -X POST --data '{...}'
```

The function, for reference or regeneration:

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

Two tokens in the personal 1Password vault, items `Cloudflare RO Token` and `Cloudflare RW Token`. The RW token needs Zone DNS Edit, Zone Read, and Account Cloudflare Tunnel Edit, scoped to specific zones rather than "All zones".

## SSH access pattern

From Mart's Mac, key-based, no password:
```sh
ssh <user>@server.home '...command...'                              # one-shot
ssh <user>@server.home                                              # interactive
```

Use absolute paths for NAS commands (`/usr/local/bin/docker`, `/usr/local/bin/git`); the SSH `$PATH` is sparse. Don't `cd` then call `git` over SSH unless you've extended `$PATH` first.

For anything long-running (terraform apply, image pulls, big copies), write to a log on the NAS and tail it back. Direct stdout inheritance over SSH breaks under network blips:

```sh
ssh <user>@server.home '
cd ~/Git/home-lab
/usr/local/bin/docker run ... terraform:latest apply -auto-approve > /tmp/tf-apply.log 2>&1
echo "exit=$?"
tail -20 /tmp/tf-apply.log
'
```

Never hard-code account or zone IDs. Fetch them:
```sh
cf /accounts                  # account IDs and names
cf /zones                     # zones (id, name, account)
```
The active CF account holds three zones. This repo manages one of them, the primary root domain, carrying the HA/n8n/sdr/echo CNAMEs plus SimpleLogin MX and DKIM records. The other two are outside the terraform state; leave them alone.

## Things deleted on purpose, don't recreate

- The belegtools stack: the `belegtools` and `belegtools-mongodb` containers, the umami and umami-db analytics pair that fed it, the `belegtools` compose network, `belegtools.tf`, and `TF_VAR_belegtools_domain_name`. Removed from this repo. The app's own source still lives in `MartBent/belegtools`.
- `/volume1/docker/belegtools/`, `/volume1/docker/homeassistant/` (304 MB, predates the `ha/` mount), `/volume1/docker/n8n/data` (548 MB orphan bind-mount; the container uses the `my-apps_n8n_data` volume), `/volume1/docker/pihole/`, `synology-dashboard/`, `private/`
- `~/${NPM_PACKAGES}/` and `~/%`, home-dir cruft from shell-expansion accidents
- `cloudflare_dns_record.drive_record`. The `drive.<root_domain>` record is VPN-only now, not tunneled.
- `TF_VAR_drive_prefix` and `TF_VAR_docker_host` from `.env`, no longer referenced

## User preferences, carry these to any session

- Prefers raw API plus curl over CLI wrappers; wrangler, flarectl, and the cloudflared CLI were all skipped. The pattern is a scoped token in 1Password behind a shell function.
- Won't weaken macOS security (Gatekeeper, xattrs) to make a binary run. Uninstalls instead of working around it.
- Minimal tooling. Fewer global installs, more shell functions that pull secrets on demand.
