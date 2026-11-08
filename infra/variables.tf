variable "project" {
  description = "Project name used as a resource prefix"
  type        = string
  default     = "math-mentor"
}

variable "region" {
  description = "AWS region (must have Bedrock model access enabled)"
  type        = string
  default     = "us-east-1"
}

variable "model_id" {
  description = "Bedrock model or inference profile ID for Claude. Uses the us. cross-region inference profile (routes through us-east-1/us-east-2/us-west-2 — requires the RegionRestriction SCP's bedrock:* carve-out)."
  type        = string
  default     = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
}

variable "alert_email" {
  description = "Email address for the monthly cost budget alerts"
  type        = string
}

variable "monthly_budget_usd" {
  description = "Monthly account cost budget (USD) that triggers alert emails"
  type        = string
  default     = "20"
}

variable "domain_name" {
  description = "Custom domain for the site. Empty string disables the custom-domain resources entirely."
  type        = string
  default     = "sumdeting.246labs.cloud"
}

variable "dns_role_arn" {
  description = "ARN of the Route53RecordWriter role in the DNS management account."
  type        = string
}

variable "dns_zone_id" {
  description = "Hosted zone id for 246labs.cloud (authoritative, mgmt account)."
  type        = string
}

variable "dns_external_id" {
  description = "External id required to assume the Route53RecordWriter role."
  type        = string
}

variable "reserved_concurrency" {
  description = "Reserved concurrent executions for the tutor Lambda. -1 = no reservation. Requires account concurrency limit > this + 10; keep -1 until a Service Quotas increase is granted."
  type        = number
  default     = -1
}
