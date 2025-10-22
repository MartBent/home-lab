variable "host_local_ip" {
  type = string
}
variable "docker_host" {
  type    = string
  default = "unix://var/run/docker.sock"
}
variable "cloudflare_api_token" {
  type = string
}
variable "homeassistant_prefix" {
  type = string
}
variable "n8n_prefix" {
  type = string
}
variable "drive_prefix" {
  type = string
}
variable "cloudflare_tunnel_name" {
  type = string
}
variable "cloudflare_domain_name" {
  type = string
}
