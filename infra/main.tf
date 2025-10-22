// get any available domain that has martbent.com in the name
data "cloudflare_zones" "this" {
  name = var.cloudflare_domain_name
}

// create a tunnel for the domain
resource "cloudflare_zero_trust_tunnel_cloudflared" "this" {
  name       = var.cloudflare_tunnel_name
  account_id = data.cloudflare_zones.this.result[0].account.id
}

// retrieve the tunnel token
data "cloudflare_zero_trust_tunnel_cloudflared_token" "tunnel_token" {
  account_id = data.cloudflare_zones.this.result[0].account.id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
}

// create application routes for tunnel
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
  account_id = data.cloudflare_zones.this.result[0].account.id
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
  value = data.cloudflare_zero_trust_tunnel_cloudflared_token.tunnel_token.token
}
