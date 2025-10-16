# HomeLab

This repo contains:
- Docker Compose services: HomeAssistant, Pi-hole, n8n, and Cloudflared (host networking)
- Terraform config to create a Cloudflare Zero Trust tunnel and DNS records

## Prerequisites
- Docker and Docker Compose
- Terraform >= 1.5
- Cloudflare API token with permissions:
  - Account: Zero Trust Tunnel: Read & Edit
  - Zone: DNS: Read & Edit

## Structure
- `docker/docker-compose.yml` – services with `network_mode: host`
- `docker/.env.example` – sample environment for Docker
- `infra/` – Terraform for Cloudflare (tunnel + DNS)

## 1) Configure Docker
Copy and edit the env file:
```bash
cp docker/.env.example docker/.env
# edit TZ, PIHOLE_WEBPASSWORD
# leave CLOUDFLARED_TUNNEL_TOKEN empty for now
```

## 2) Provision Cloudflare with Terraform
Set variables via `terraform.tfvars` or CLI vars. Provider uses `var.cloudflare_api_token`.

Example `infra/terraform.tfvars`:
```hcl
cloudflare_api_token    = "<your token>"
host_local_ip           = "192.168.2.20"
homeassistant_hostname  = "homelab_homeassistant"
n8n_hostname            = "homelab_n8n"
cloudflare_tunnel_name  = "HomeLab Tunnel"
```

Apply:
```bash
terraform -chdir=infra init
terraform -chdir=infra apply -auto-approve
```

After apply, retrieve the tunnel token:
```bash
terraform -chdir=infra output -raw cloudflare_tunnel_token
```
Paste this value into `docker/.env` as `CLOUDFLARED_TUNNEL_TOKEN`.

Notes:
- Two CNAME records are created pointing to the tunnel for the provided hostnames.

## 3) Launch services
```bash
docker compose -f docker/docker-compose.yml up -d
```

Services (host networking):
- HomeAssistant: http://127.0.0.1:8123
- Pi-hole Admin: http://127.0.0.1/admin
- n8n: http://127.0.0.1:5678
- Cloudflared: runs the Cloudflare connector; requires `CLOUDFLARED_TUNNEL_TOKEN` in `docker/.env`

### Cloudflared service
- Image: `cloudflare/cloudflared:latest`
- Networking: host
- Command: `tunnel --no-autoupdate run`
- Configure by setting `CLOUDFLARED_TUNNEL_TOKEN` from Terraform output