// setup CNAME reccord for external access
resource "cloudflare_dns_record" "n8n_record" {
  zone_id = data.cloudflare_zones.this.result[0].id
  name    = var.n8n_prefix
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

// define ingress routing for n8n
locals {
  ingress_n8n = [
    {
      hostname = "${var.n8n_prefix}.${var.cloudflare_domain_name}"
      service  = "http://${var.host_local_ip}:5678"
    }
  ]
}
