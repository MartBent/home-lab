// Shared locals to avoid duplication across resources
locals {
  // Cloudflare identifiers
  account_id = data.cloudflare_zones.this.result[0].account.id
  zone_id    = data.cloudflare_zones.this.result[0].id

  // Tunnel id
  tunnel_id = cloudflare_zero_trust_tunnel_cloudflared.this.id
}


