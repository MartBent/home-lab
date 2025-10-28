// get any available domain that has "cloudflare_domain_name" in the name
data "cloudflare_zones" "this" {
  name = var.cloudflare_domain_name
}

// create a tunnel for the domain
resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  name       = var.cloudflare_tunnel_name
  account_id = local.account_id
}

// retrieve the tunnel token
data "cloudflare_zero_trust_tunnel_cloudflared_token" "tunnel_token" {
  account_id = local.account_id
  tunnel_id  = local.tunnel_id
}

// create application routes for tunnel
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  tunnel_id  = local.tunnel_id
  account_id = local.account_id
  config = {
    ingress = concat(
      local.ingress_homeassistant,
      local.ingress_n8n,
      local.ingress_drive,
      [
        {
          service = "http_status:404"
        }
      ]
    )
  }
}

output "cloudflare_tunnel_token" {
  value     = data.cloudflare_zero_trust_tunnel_cloudflared_token.tunnel_token.token
  sensitive = true
}

resource "docker_image" "cloudflared" {
  name = "cloudflare/cloudflared:latest"
}

resource "docker_container" "cloudflared" {
  image        = docker_image.cloudflared.name
  name         = "cloudflared"
  network_mode = "host"
  restart      = "unless-stopped"
  env = [
    "TUNNEL_TOKEN= ${data.cloudflare_zero_trust_tunnel_cloudflared_token.tunnel_token.token}"
  ]
}
