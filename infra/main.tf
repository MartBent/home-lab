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

// create CNAME records for the tunnel
resource "cloudflare_dns_record" "homeassistant_record" {
  zone_id = data.cloudflare_zones.this.result[0].id
  name    = var.homeassistant_prefix
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

resource "cloudflare_dns_record" "n8n_record" {
  zone_id = data.cloudflare_zones.this.result[0].id
  name    = var.n8n_prefix
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

// create application routes for tunnel
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "this" {
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.this.id
  account_id = data.cloudflare_zones.this.result[0].account.id
  config = {
    ingress = [
      {
        hostname = "${var.homeassistant_prefix}.${var.cloudflare_domain_name}"
        service  = "http://${var.host_local_ip}:8123"
      },
      {
        hostname = "${var.n8n_prefix}.${var.cloudflare_domain_name}"
        service  = "http://${var.host_local_ip}:5678"
      },
      {
        hostname = "${var.drive_prefix}.${var.cloudflare_domain_name}"
        service  = "https://${var.host_local_ip}"
      },
      {
        service = "http_status:404"
      }
    ]
  }
}

output "cloudflare_tunnel_token" {
  value = data.cloudflare_zero_trust_tunnel_cloudflared_token.tunnel_token.token
}
