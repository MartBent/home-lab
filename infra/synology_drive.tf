// setup CNAME reccord for external access
resource "cloudflare_dns_record" "drive_record" {
  zone_id = data.cloudflare_zones.this.result[0].id
  name    = var.drive_prefix
  content = "${cloudflare_zero_trust_tunnel_cloudflared.this.id}.cfargotunnel.com"
  type    = "CNAME"
  ttl     = 1
  proxied = true
}

// define ingress routing for synology drive
locals {
  ingress_drive = [
    {
      hostname = "${var.drive_prefix}.${var.cloudflare_domain_name}"
      service  = "https://${var.host_local_ip}:5001"
      origin_request = {
        no_tls_verify = true
      }
    }
  ]
}

// setup the docker service
