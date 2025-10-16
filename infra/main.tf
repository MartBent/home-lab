// get any available domain that has martbent.com in the name
data "cloudflare_zones" "this" {
  name = "martbent.com"
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
  name    = var.homeassistant_hostname
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

resource "cloudflare_dns_record" "n8n_record" {
  zone_id = data.cloudflare_zones.this.result[0].id
  name    = var.n8n_hostname
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

output "cloudflare_zone" {
  value = data.cloudflare_zones.this.result[0]
}

// output the token used to run the tunnel service
output "cloudflare_tunnel_token" {
  value = data.cloudflare_zero_trust_tunnel_cloudflared_token.tunnel_token.token
}
