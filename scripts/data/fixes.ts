/**
 * PayNest's canonical, company-specific fixes: one internal `pnctl` runbook
 * action per failure family (per mechanism for TLS/secrets and config/flags),
 * reused verbatim every time the failure recurs. A memory-less agent can't know
 * these, and that is the knowledge the "right fix first try" metric measures.
 */
export const PAYNEST_FIX = {
  dbPool: (service: string) =>
    `ran runbook RB-PG-07: \`pnctl db pool-cap ${service} --size 5 --overflow 5\` (sets PN_DB_POOL_SIZE=5 / PN_DB_MAX_OVERFLOW=5 and rolls ${service})`,
  redis: (prefix: string) =>
    `ran runbook RB-CACHE-04: \`pnctl cache harden ${prefix}*\` (CACHE_TTL_JITTER_PCT=20 + singleflight on the prefix) and \`pnctl redis resize redis-cache --maxmemory 24gb\``,
  npci: (bank: string) =>
    `ran runbook RB-UPI-03: \`pnctl upi failover --psp ${bank} --route npci-dc2\` (opens the npci-${bank.toLowerCase()} breaker, routes ${bank} via NPCI-DC2, ReqPay timeout 8s)`,
  kafka: () =>
    "ran runbook RB-KAFKA-02: `pnctl kafka stabilize notif-worker` (CooperativeStickyAssignor + static group.instance.id, max.poll.records=500, replicas capped at partition count)",
  certRenew: (domain: string) =>
    `ran runbook RB-SEC-01: restored the cert-manager Route53 IAM role, then \`pnctl certs renew ${domain}\``,
  jwksReload: () => "ran runbook RB-SEC-03: `pnctl auth jwks-reload` on auth-svc (and set JWKS cache TTL to 5 min)",
  secretResync: (service: string) =>
    `ran runbook RB-SEC-02: \`pnctl secrets resync ${service}\` (forces the ExternalSecret sync of the rotated Vault creds and rolls ${service})`,
  npciClientCert: () =>
    "ran runbook RB-SEC-04: `pnctl certs issue npci-client` (new NPCI mTLS client cert from Vault PKI) and reloaded upi-gateway",
  flagKill: (flag: string) => `ran runbook RB-REL-01: \`pnctl flags kill ${flag}\` (Unleash kill switch); 5xx back to baseline within 90s`,
  configRollback: () =>
    "ran runbook RB-REL-02: `pnctl config rollback payments-api-config` (kubectl rollout undo does not revert ConfigMaps)",
};
