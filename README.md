# Home Lab

Infrastructure-as-code for a Synology-powered homelab, managed entirely with Terraform executed inside Docker. The configuration provisions:

- Cloudflare Zero Trust tunnel and DNS records for remote access
- Several self-hosted services using docker containers
- Ingress rules that route Cloudflare traffic back to services on the LAN

## Requirements

- **Synology DSM** with the Docker package installed
- **Terraform >= 1.5**, executed via the official Docker image
- **Cloudflare API token** with:
  - Account: Zero Trust Tunnel (Read & Edit)
  - Zone: DNS (Read & Edit)

## Repository Layout
The infrastructure consists of 2 part, the shared (cloudflare) configurations, and several containerized services.

### Cloudflare:
- `providers.tf` – Cloudflare and Docker providers
- `variables.tf` – Input variables for tokens, prefixes, and host paths
- `locals.tf` – Shared Cloudflare identifiers (account, zone, tunnel)
- `cloudflare.tf` – Tunnel resources, ingress config, and Cloudflared container

These components set up the required cloudflare tunnel, CNAME records, ingress rules and the cloudflared docker container for LAN routing.

### Services:
- `homeassistant.tf` - For home automation
- `n8n.tf` - For automated bookkeeping, agentic homeassistant interaction, etc..

## Configure Terraform in Docker on Synology DSM

1. Grant your DSM user access to Docker:

   ```bash
   sudo synogroup -add docker "$USER"
   sudo chown root:docker /var/run/docker.sock
   ```

   Log out and back in (or reboot) so the new group membership takes effect.

2. Add a Terraform helper function so every Terraform command runs inside the official Docker image:

   ```bash
   terraform() {
     docker run --rm \
       --env-file "$PWD/.env" \
       -v "$PWD":/workspace \
       -v /var/run/docker.sock:/var/run/docker.sock \
       -w /workspace \
       hashicorp/terraform:latest "$@"
   }
   ```
## Configuration

Populate a `.env` file in the repository root with Terraform variables. Terraform automatically maps any variable prefixed with `TF_VAR_` to the corresponding input variable in your configuration:

```bash
TF_VAR_cloudflare_api_token=<your token>
TF_VAR_cloudflare_domain_name=example.com
TF_VAR_cloudflare_tunnel_name=homelab-tunnel
TF_VAR_host_local_ip=192.168.1.10

# Service subdomain prefixes
TF_VAR_homeassistant_prefix=ha
TF_VAR_n8n_prefix=n8n

# Local data paths for containers (required)
TF_VAR_homeassistant_config_path=/srv/homeassistant/config
TF_VAR_n8n_data_path=/srv/n8n/data

# Optional: override the Docker socket location
# TF_VAR_docker_host=unix:///var/run/docker.sock
```

## Usage

Run Terraform commands as usual—the wrapper forwards arguments to the Dockerised CLI:

```bash
terraform init
terraform plan
terraform apply --auto-approve
```

To tear everything down:

```bash
terraform destroy --auto-approve
```