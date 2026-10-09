# Home lab

Infrastructure-as-code for a Synology-powered homelab, split in two layers:

- **Terraform** manages Cloudflare: the tunnel, DNS records, and ingress routing
- **Docker Compose** manages every container on the NAS

## Repository layout

```
├── cloudflare.tf          # tunnel, ingress config, tunnel-token output
├── homeassistant.tf       # HA DNS record + ingress
├── n8n.tf                 # n8n DNS record + ingress
├── rfid-analyzer.tf       # RFID analyzer DNS record + ingress
├── echo.tf                # echo server DNS record + ingress
├── providers.tf           # Cloudflare provider
├── variables.tf           # input variables
├── locals.tf              # shared Cloudflare identifiers
├── .env.example           # terraform vars (copy to .env, fill in)
├── homeassistant/         # HA sources worth version control (theme, dashboards, automations)
├── ha/                    # live HA /config (gitignored, lives only on the NAS)
└── docker/
    └── my-apps/
        ├── .env.example   # compose env vars (copy to .env, fill in)
        ├── docker-compose.yml
        └── echo-server/   # Dockerfile + app.py for the echo container
```

`homeassistant/` and `ha/` are different things and the names are confusingly close. `homeassistant/` holds the sources this repo tracks. `ha/` is the live config directory the container mounts, and it never leaves the NAS. See `homeassistant/README.md` for how to deploy one into the other.

## Services

Everything runs from a single compose project named `my-apps`.

| Service (container) | Image | Port | Subdomain |
|---|---|---|---|
| `homeassistant` | ghcr.io/home-assistant/home-assistant:stable | 8123 (host net) | `ha` |
| `n8n` | docker.n8n.io/n8nio/n8n:latest | 5678 (host net) | `n8n` |
| `cloudflared` | cloudflare/cloudflared:latest | — (host net) | — |
| `rfid-analyzer` | ghcr.io/martbent/rtl-sdr-uhf-rfid-analyzer:latest | 8080 → 80 | `sdr` |
| `echo-server` | built from `docker/my-apps/echo-server/` | 8082 → 80 | `echo` |
| `watchtower` | containrrr/watchtower | — | — |

The echo server answers POST with a JSON dump of the request it received, and 405 on every other method. It's there for testing webhooks end to end through the tunnel.

Watchtower runs in label-only mode. It auto-updates only containers carrying the `com.centurylinklabs.watchtower.enable=true` label, currently `rfid-analyzer` and watchtower itself. Third-party images (HA, n8n, cloudflared) are updated by hand so a data-layer upgrade never arrives as a surprise.

## Requirements

- **Synology DSM** with the Docker/Container Manager package installed
- **Terraform >= 1.5**, run from the official Docker image
- **Cloudflare API token** with Account: Zero Trust Tunnel (Read & Edit) and Zone: DNS (Read & Edit)

## Setup

Bring-up order is terraform first, then grab the tunnel token, then compose up. That order is forced: `CLOUDFLARE_TUNNEL_TOKEN` is an output of `terraform apply`.

### 1. Terraform

Add a helper so every command runs inside the official image:

```bash
terraform() {
  docker run --rm \
    --env-file "$PWD/.env" \
    -v "$PWD":/workspace \
    -w /workspace \
    hashicorp/terraform:latest "$@"
}
```

Copy `.env.example` to `.env` (gitignored) and fill it in:

```bash
TF_VAR_cloudflare_api_token=<your token>
TF_VAR_cloudflare_domain_name=example.com
TF_VAR_cloudflare_tunnel_name=HomeLab
TF_VAR_host_local_ip=server.home          # hostname or IP the cloudflared container resolves
TF_VAR_homeassistant_prefix=ha
TF_VAR_n8n_prefix=n8n
TF_VAR_rfid_analyzer_prefix=sdr
TF_VAR_echo_prefix=echo
```

Apply:

```bash
terraform init
terraform apply -auto-approve
```

### 2. Grab the tunnel token

```bash
terraform output -raw cloudflare_tunnel_token
```

### 3. Compose env file

```bash
cp docker/my-apps/.env.example docker/my-apps/.env
chmod 600 docker/my-apps/.env
# paste the token from step 2 into CLOUDFLARE_TUNNEL_TOKEN, then fill in N8N_* and GHCR_*
```

This one file holds every compose-time var. Compose loads it automatically because it sits next to `docker-compose.yml`.

### 4. Home Assistant config

`ha/` is gitignored because it holds HA's runtime config, database, and backups. On a fresh setup, create it with at least:

```yaml
# ha/configuration.yaml
default_config:

http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 192.168.0.0/24    # LAN subnet; cloudflared runs on host net and appears from the NAS IP
    - 127.0.0.1
```

The `trusted_proxies` block is not optional. Cloudflared runs in `network_mode: host` and reaches HA at `http://server.home:8123`, so from HA's side the X-Forwarded-For arrives from the host's LAN IP. Without the entry, HA returns `400 Bad Request` on every proxied request.

Then deploy the tracked sources from `homeassistant/` as described in `homeassistant/README.md`.

### 5. Compose up

```bash
DOCKER=/usr/local/bin/docker
$DOCKER compose -f docker/my-apps/docker-compose.yml up -d
```

### 6. GHCR authentication (for private images)

```bash
docker login ghcr.io -u <github-username>
```

Enter a Personal Access Token with `read:packages` scope.

## Token rotation

After rotating the Cloudflare API token, or after a `terraform destroy` + `apply` that minted a new tunnel token:

```bash
# in repo root
terraform apply -auto-approve
NEW_TOKEN=$(terraform output -raw cloudflare_tunnel_token)
sed -i.bak -E "s|^CLOUDFLARE_TUNNEL_TOKEN=.*|CLOUDFLARE_TUNNEL_TOKEN=$NEW_TOKEN|" docker/my-apps/.env
rm docker/my-apps/.env.bak
docker compose -f docker/my-apps/docker-compose.yml up -d --force-recreate cloudflared
```
