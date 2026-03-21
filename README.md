# Home Lab

Infrastructure-as-code for a Synology-powered homelab. The setup is split into two layers:

- **Terraform** manages Cloudflare infrastructure (tunnel, DNS records, ingress routing)
- **Docker Compose** manages all containerized services on the NAS

## Repository Layout

```
├── cloudflare.tf          # Tunnel, ingress config
├── homeassistant.tf       # HA DNS record + ingress
├── n8n.tf                 # n8n DNS record + ingress
├── rfid-analyzer.tf       # RFID analyzer DNS record + ingress
├── providers.tf           # Cloudflare provider
├── variables.tf           # Input variables
├── locals.tf              # Shared Cloudflare identifiers
└── docker/
    ├── .env.example       # Required env vars (copy to ~/.env on NAS)
    ├── services/          # Third-party services (HA, n8n, cloudflared)
    │   └── docker-compose.yml
    └── my-apps/           # Self-managed images + Watchtower
        └── docker-compose.yml
```

## Services

| Service | Compose Stack | Port | Subdomain |
|---------|--------------|------|-----------|
| Home Assistant | services | 8123 | `ha` |
| n8n | services | 5678 | `n8n` |
| Cloudflared | services | - | - |
| RFID Analyzer | my-apps | 8080 | `sdr` |
| Watchtower | my-apps | - | - |

**Watchtower** runs in label-only mode — it only auto-updates containers with the `com.centurylinklabs.watchtower.enable=true` label (currently just `rfid-analyzer`). Third-party services are updated manually.

## Requirements

- **Synology DSM** with the Docker/Container Manager package installed
- **Terraform >= 1.5**, executed via the official Docker image
- **Cloudflare API token** with:
  - Account: Zero Trust Tunnel (Read & Edit)
  - Zone: DNS (Read & Edit)

## Setup

### 1. Environment variables

Copy `docker/.env.example` to `~/.env` on the NAS and fill in the values:

```bash
cp docker/.env.example ~/.env
chmod 600 ~/.env
```

### 2. Docker Compose

Start the services on the NAS:

```bash
DOCKER=/volume1/@appstore/ContainerManager/usr/bin/docker

# Third-party services
$DOCKER compose --env-file ~/.env -f docker/services/docker-compose.yml up -d

# Self-managed apps + Watchtower
$DOCKER compose --env-file ~/.env -f docker/my-apps/docker-compose.yml up -d
```

### 3. Terraform

Add a Terraform helper function so every command runs inside the official Docker image:

```bash
terraform() {
  docker run --rm \
    --env-file "$PWD/.env" \
    -v "$PWD":/workspace \
    -w /workspace \
    hashicorp/terraform:latest "$@"
}
```

Configure Terraform variables in a `.env` file in the repo root:

```bash
TF_VAR_cloudflare_api_token=<your token>
TF_VAR_cloudflare_domain_name=example.com
TF_VAR_host_local_ip=192.168.1.204
TF_VAR_homeassistant_prefix=ha
TF_VAR_n8n_prefix=n8n
TF_VAR_rfid_analyzer_prefix=sdr
```

Then run:

```bash
terraform init
terraform plan
terraform apply --auto-approve
```

### 4. GHCR authentication

To pull private images from GitHub Container Registry:

```bash
docker login ghcr.io -u <github-username>
```

Enter a Personal Access Token with `read:packages` scope.
