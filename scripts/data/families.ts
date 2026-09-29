/** Scenario templates for the six recurring PayNest failure families. */
import type { Family } from "../../lib/types";
import { alertOf, DEVS, logTs, podName, reqId, type Rng, type Scenario } from "./common";

export interface Ctx {
  rng: Rng;
  startedAt: string;
  /** Business context such as "salary day" or "Onam sale", if any. */
  occasion: string | null;
}

const fmtInt = (n: number) => n.toLocaleString("en-IN");
const ratio = (rng: Rng, lo: number, hi: number) => (rng.int(lo, hi) / 100).toFixed(2);

function change(
  rng: Rng,
  startedAt: string,
  kind: Scenario["change"]["kind"],
  service: string,
  description: string,
  minutesBefore = rng.int(12, 95),
) {
  return {
    kind,
    service,
    description: kind === "none" ? "No deploy, config or infra change in the preceding 24h" : description,
    sha: kind === "none" ? null : rng.hex(7),
    author: kind === "none" ? null : rng.pick(DEVS),
    at: kind === "none" ? null : new Date(new Date(startedAt).getTime() - minutesBefore * 60_000).toISOString(),
  };
}

// ------------------------------------------------------------------ DB pool

function dbPool({ rng, startedAt }: Ctx): Scenario {
  const variant = rng.int(0, 3);
  const service = variant === 3 ? "ledger-svc" : "payments-api";
  const pods = rng.pick([18, 24, 30]);
  const before = rng.pick([4, 8]);
  const after = before * 2;
  const pool = rng.pick([10, 20]);
  const potential = pods * after * pool;
  const maxConn = rng.pick([500, 600, 800]);
  const pod = podName(service, rng);
  const triggers = [
    `payments-api deploy raised gunicorn WORKERS from ${before} to ${after} per pod ("scale for salary-day load")`,
    `payments-api HPA maxReplicas raised from ${pods / 2} to ${pods} ahead of a sale, each pod holding pool_size=${pool}`,
    `payments-api deploy added a settlement-report background thread pool (8 threads) sharing the request DB pool`,
    `ledger-svc deploy increased Hikari maximumPoolSize from 20 to 60 and raised replicas to ${pods / 2}`,
  ];
  const c = change(rng, startedAt, variant === 1 ? "config" : "deploy", service, triggers[variant]!);
  const javaStyle = service === "ledger-svc";
  const logs = [
    javaStyle
      ? `${logTs(startedAt, -40, rng)} ERROR ${pod} [http-nio-8080-exec-${rng.int(10, 199)}] c.z.h.p.HikariPool - HikariPool-1 - Connection is not available, request timed out after 30000ms (total=60, active=60, idle=0, waiting=${rng.int(180, 420)})`
      : `${logTs(startedAt, -40, rng)} ERROR ${pod} [req=${reqId(rng)}] sqlalchemy.exc.TimeoutError: QueuePool limit of size ${pool} overflow 10 reached, connection timed out, timeout 30.00`,
    `${logTs(startedAt, -31, rng)} LOG pgbouncer-0 C-0x55d${rng.hex(5)}: paynest/${service.replace("-", "_")}_rw@10.4.${rng.int(10, 40)}.${rng.int(2, 250)}:${rng.int(40000, 60000)} closing because: no more connections allowed (max_client_conn) (age=0s)`,
    `${logTs(startedAt, -22, rng)} FATAL postgres-primary: remaining connection slots are reserved for non-replication superuser connections`,
    `${logTs(startedAt, -15, rng)} WARN envoy [payments] upstream connect error or disconnect/reset before headers. reset reason: connection timeout, upstream=${service}:8080`,
    `${logTs(startedAt, -9, rng)} ERROR ${pod} POST /v1/payments/collect 503 latency_ms=${rng.int(29000, 30500)} err="db acquire timeout"`,
    `${logTs(startedAt, -4, rng)} INFO postgres-exporter pg_stat_activity count=${maxConn - rng.int(0, 3)} max_connections=${maxConn} state_idle_in_transaction=${rng.int(40, 190)}`,
    `${logTs(startedAt, 2, rng)} WARN ${pod} health check /readyz failed: db ping timeout after 2000ms`,
  ];
  const failedPool = [
    { fix: `restarted ${service} pods (kubectl rollout restart deploy/${service})`, why: "pool re-exhausted within 4 minutes as new workers reconnected" },
    { fix: `scaled ${service} HPA up by 50%`, why: "more pods = more connections; postgres hit max_connections faster" },
    { fix: "raised postgres max_connections", why: "needs a primary restart; rejected, and RAM per connection made it risky" },
    { fix: "killed idle-in-transaction sessions with pg_terminate_backend", why: "slots freed for ~90s then filled again" },
  ];
  const nFailed = rng.int(1, 2);
  const failed = rng.shuffle(failedPool.slice(0, 3)).slice(0, nFailed);
  if (!failed.some((f) => f.fix.startsWith("restarted")) && rng.chance(0.6)) failed[0] = failedPool[0]!;
  const fixes = [
    `capped pool per worker (pool_size=5, max_overflow=5) via hotfix config and rolled ${service}; active connections fell from ${maxConn} to ~${Math.round(maxConn * 0.4)}`,
    `rolled back deploy ${c.sha} to restore WORKERS=${before}; connection count normalised in 3 minutes`,
    `switched pgbouncer to transaction pooling for ${service} and lowered pool_size to 5`,
  ];
  return {
    title: `${service} 5xx — DB connection pool exhausted`,
    service,
    severity: rng.pick(["SEV1", "SEV2"] as const),
    alert: alertOf({
      alertname: variant === 3 ? "LedgerWriteLatencyHigh" : "PaymentsAPIHigh5xxRate",
      service,
      severity: "SEV1",
      summary: variant === 3 ? "ledger-svc write p99 above 5s" : `payments-api 5xx ratio above 5% (${rng.int(8, 31)}%)`,
      description: `Error budget burn rate ${rng.int(14, 40)}x over 5m on ${service}.`,
      expr:
        variant === 3
          ? 'histogram_quantile(0.99, sum by (le) (rate(ledger_write_duration_seconds_bucket[5m]))) > 5'
          : 'sum(rate(http_requests_total{service="payments-api",code=~"5.."}[5m])) / sum(rate(http_requests_total{service="payments-api"}[5m])) > 0.05',
      value: variant === 3 ? `${rng.int(6, 29)}.${rng.int(1, 9)}` : ratio(rng, 8, 31),
      startsAt: startedAt,
    }),
    logs,
    change: c,
    rootCause: `${triggers[variant]} (commit ${c.sha}). ${pods} pods x ${after} workers x pool ${pool} = up to ${fmtInt(potential)} connections against postgres max_connections=${maxConn} behind pgbouncer; the connection pool was exhausted at peak and requests timed out waiting for a connection.`,
    fixThatWorked: rng.pick(fixes),
    fixesThatFailed: failed,
    eureka: `found it — ${c.sha} by ${c.author} bumped concurrency; ${pods}x${after}x${pool} connections vs max_connections=${maxConn}. pool exhaustion, not a code bug`,
    impact: `${fmtInt(rng.int(9000, 61000))} failed UPI collect requests (~₹${rng.int(2, 19)} Cr GMV delayed).`,
    actionItems: [
      "Add CI check: workers x replicas x pool_size must stay below pgbouncer max_client_conn",
      "Alert on pgbouncer cl_waiting > 50",
      "Document that pod restarts do not fix pool exhaustion",
    ],
  };
}

// ------------------------------------------------------------------ Redis

function redis({ rng, startedAt, occasion }: Ctx): Scenario {
  const variant = rng.int(0, 2);
  const service = rng.pick(["payments-api", "upi-gateway", "auth-svc"] as const);
  const prefix = service === "auth-svc" ? "sess:" : service === "upi-gateway" ? "vpa:resolve:" : "merchant:cfg:";
  const table = service === "auth-svc" ? "user_sessions" : service === "upi-gateway" ? "vpa_registry" : "merchant_config";
  const occ = occasion ?? "salary day";
  const maxmem = rng.pick([8, 12, 16]);
  const triggers = [
    `${service} deploy set a flat TTL of 300s on all ${prefix}* keys (was 1h with jitter)`,
    `${occ} peak traffic (${rng.int(3, 6)}x normal TPS) pushed redis-cache past maxmemory ${maxmem}GB`,
    `${service} deploy started caching full merchant/user objects (~40KB each) instead of IDs`,
  ];
  const c = change(rng, startedAt, variant === 1 ? "none" : "deploy", service, triggers[variant]!, rng.int(60, 600));
  const pod = podName(service, rng);
  const logs = [
    `${logTs(startedAt, -55, rng)} WARN redis-cache-0 1:M # evicted ${fmtInt(rng.int(30000, 90000))} keys in last 60s (maxmemory-policy allkeys-lru, used_memory=${maxmem}.0G)`,
    `${logTs(startedAt, -41, rng)} WARN ${pod} cache miss ratio ${rng.int(62, 91)}% for prefix ${prefix}* (baseline 4%)`,
    `${logTs(startedAt, -33, rng)} LOG postgres-primary duration: ${rng.int(1800, 4200)}.${rng.int(100, 999)} ms statement: SELECT * FROM ${table} WHERE id = $1`,
    `${logTs(startedAt, -20, rng)} ERROR ${pod} redis.exceptions.TimeoutError: Timeout reading from socket (redis-cache:6379)`,
    `${logTs(startedAt, -12, rng)} WARN redis-cache-0 1:M # Client id=${rng.int(1000, 9999)} addr=10.4.${rng.int(10, 40)}.${rng.int(2, 250)} scheduled to be closed ASAP for overcoming of output buffer limits`,
    `${logTs(startedAt, -3, rng)} ERROR ${pod} OOM command not allowed when used memory > 'maxmemory'`,
    `${logTs(startedAt, 6, rng)} INFO ${pod} p99 latency ${rng.int(2100, 6800)}ms for GET ${service === "auth-svc" ? "/v1/session" : "/v1/vpa/resolve"}`,
  ];
  const failed = rng.shuffle([
    { fix: "FLUSHALL on redis-cache to clear memory", why: "cold cache doubled DB load; destructive and made latency worse" },
    { fix: "restarted redis-cache-0", why: "cache came back empty; stampede got worse" },
    { fix: `scaled ${service} pods up`, why: "more concurrent cache misses hitting postgres" },
  ]).slice(0, rng.int(0, 2));
  return {
    title: `${service} latency spike — Redis eviction storm${occasion ? ` during ${occasion}` : ""}`,
    service,
    severity: rng.pick(["SEV2", "SEV1"] as const),
    alert: alertOf({
      alertname: rng.pick(["RedisEvictionsHigh", "RedisMemoryHigh", "PaymentsLatencyP99High"]),
      service,
      severity: "SEV2",
      summary: `redis-cache evictions > 1000/s; ${service} p99 degraded`,
      description: `Evicted keys rate ${fmtInt(rng.int(1200, 9000))}/s on redis-cache-0; memory ${rng.int(96, 100)}% of maxmemory.`,
      expr: 'rate(redis_evicted_keys_total{instance="redis-cache-0"}[1m]) > 1000',
      value: `${rng.int(1200, 9000)}`,
      startsAt: startedAt,
      extraLabels: { instance: "redis-cache-0" },
    }),
    logs,
    change: c,
    rootCause: `${triggers[variant]}${c.sha ? ` (commit ${c.sha})` : ""}. Hot ${prefix}* keys were evicted/expired together during ${occ} peak, causing a cache stampede onto ${table} in postgres and a Redis eviction storm.`,
    fixThatWorked: rng.pick([
      `added ±20% TTL jitter and singleflight request coalescing on ${prefix}*; raised redis maxmemory ${maxmem}GB → ${maxmem + 8}GB`,
      `enabled stale-while-revalidate for ${prefix}* and scaled redis-cache to a 6-shard cluster`,
      `rolled back ${c.sha ?? "the caching change"} and pre-warmed ${prefix}* from a replica snapshot`,
    ]),
    fixesThatFailed: failed,
    eureka: `it's the cache — ${prefix}* evicting en masse, every miss is a ${table} query. classic ${occ} stampede`,
    impact: `p99 latency ${rng.int(2, 7)}s for ${rng.int(18, 55)} min; ${fmtInt(rng.int(4000, 30000))} timeouts at checkout.`,
    actionItems: ["TTL jitter everywhere", "Pre-scale redis-cache before salary day and sale events", "Ban FLUSHALL in prod without approval"],
  };
}

// ------------------------------------------------------------------ NPCI / bank

function npci({ rng, startedAt }: Ctx): Scenario {
  const bank = rng.pick(["HDFC", "SBI", "ICICI", "Axis", "Kotak", "BoB"]);
  const ifsc = { HDFC: "HDFC0000001", SBI: "SBIN0000001", ICICI: "ICIC0000001", Axis: "UTIB0000001", Kotak: "KKBK0000001", BoB: "BARB0000001" }[bank]!;
  const variant = rng.int(0, 2);
  const triggers = [
    `${bank} remitter-bank switch degraded behind NPCI (external); no internal change`,
    `NPCI primary data-centre (NPCI-DC1) latency spike for ${bank} routes; no internal change`,
    `${bank} unannounced maintenance on its UPI switch; upi-gateway kept routing at full rate`,
  ];
  const c = rng.chance(0.35)
    ? change(rng, startedAt, "deploy", "upi-gateway", "upi-gateway deploy: refactored retry helper (unrelated red herring)", rng.int(120, 900))
    : change(rng, startedAt, "none", "upi-gateway", "none");
  const pod = podName("upi-gateway", rng);
  const rrn = () => `${rng.int(6, 6)}${rng.hex(11).replace(/[a-f]/g, "7")}`;
  const logs = [
    `${logTs(startedAt, -70, rng)} ERROR ${pod} [txn=PNST${rng.hex(10).toUpperCase()}] NPCI ReqPay timeout after 30000ms payer_psp=${bank} ifsc=${ifsc} rrn=${rrn()}`,
    `${logTs(startedAt, -52, rng)} WARN ${pod} npci-client pool saturation active=200/200 queued=${rng.int(600, 1000)}/1000`,
    `${logTs(startedAt, -40, rng)} ERROR ${pod} RespPay result=FAILURE errCode=U90 (remitter bank not reachable) payer_psp=${bank}`,
    `${logTs(startedAt, -28, rng)} WARN ${pod} circuit-breaker npci-${bank.toLowerCase()} state=DISABLED failureRate=${rng.int(48, 79)}.${rng.int(0, 9)}%`,
    `${logTs(startedAt, -15, rng)} WARN payments-api-${rng.hex(9)} txn PNST${rng.hex(10).toUpperCase()} moved to DEEMED/PENDING, reconciliation scheduled`,
    `${logTs(startedAt, -6, rng)} ERROR ${pod} java.util.concurrent.RejectedExecutionException: Task rejected from npci-client executor`,
    `${logTs(startedAt, 4, rng)} INFO ${pod} success_rate{psp="${bank}"}=${rng.int(22, 61)}% success_rate{psp!="${bank}"}=${rng.int(81, 93)}%`,
  ];
  const failed = rng.shuffle([
    { fix: "restarted upi-gateway pods", why: "timeouts returned immediately; cause is external" },
    { fix: "raised npci-client timeout 30s → 60s", why: "threads held twice as long, starvation spread to healthy banks" },
    { fix: "rolled back the latest upi-gateway deploy", why: "no change; the deploy was unrelated" },
    { fix: "bulk-retried failed ReqPay calls", why: "risk of duplicate debits; stopped by payments lead" },
  ]).slice(0, rng.int(1, 2));
  return {
    title: `upi-gateway success rate drop — ${bank} timeouts at NPCI`,
    service: "upi-gateway",
    severity: rng.pick(["SEV1", "SEV2"] as const),
    alert: alertOf({
      alertname: rng.pick(["UPISuccessRateLow", "UPIPSPTimeoutRateHigh"]),
      service: "upi-gateway",
      severity: "SEV1",
      summary: `UPI success rate ${rng.int(71, 88)}% (SLO 97%); timeouts concentrated on payer_psp=${bank}`,
      description: `Timeout ratio for ${bank} ${rng.int(30, 70)}% over 5m.`,
      expr: 'sum by (payer_psp) (rate(upi_txn_total{status="timeout"}[5m])) / sum by (payer_psp) (rate(upi_txn_total[5m])) > 0.1',
      value: ratio(rng, 30, 70),
      startsAt: startedAt,
      extraLabels: { payer_psp: bank },
    }),
    logs,
    change: c,
    rootCause: `${triggers[variant]}. upi-gateway had no per-bank circuit breaker, so 30s NPCI timeouts for ${bank} saturated the shared npci-client thread pool and dragged success rate down for every bank.`,
    fixThatWorked: rng.pick([
      `enabled per-bank circuit breaker for npci-${bank.toLowerCase()} (resilience4j, 50% failure threshold) and failed over ${bank} routes to NPCI-DC2; cut ReqPay timeout 30s → 8s`,
      `opened the ${bank} circuit breaker manually, routed ${bank} via the secondary NPCI endpoint and isolated it in a bulkhead thread pool`,
    ]),
    fixesThatFailed: failed,
    eureka: `it's ${bank}, not us — U90s only for payer_psp=${bank}, and they're starving the shared npci-client pool. need the breaker + failover`,
    impact: `${fmtInt(rng.int(20000, 140000))} UPI transactions failed or went DEEMED; ${bank} customers most affected.`,
    actionItems: ["Per-bank bulkheads in npci-client", "Auto circuit breaker per payer_psp", "Status page template for partner-bank degradation"],
  };
}

// ------------------------------------------------------------------ Kafka

function kafka({ rng, startedAt }: Ctx): Scenario {
  const variant = rng.int(0, 3);
  const partitions = rng.pick([12, 24]);
  const triggers = [
    `notif-worker deploy raised max.poll.records from 500 to 5000 while SMS provider calls stay synchronous`,
    `notif-worker scaled from 6 to ${partitions + 8} replicas, more consumers than the ${partitions} partitions of payment.events`,
    `kafka rolling upgrade restarted kafka-2 (group coordinator), triggering a group rebalance with the eager assignor`,
    `payment.events partitions increased from ${partitions} to ${partitions * 2}, triggering a full rebalance of notif-worker`,
  ];
  const c = change(rng, startedAt, variant === 2 ? "infra" : variant === 3 ? "config" : "deploy", variant >= 2 ? "kafka" : "notif-worker", triggers[variant]!);
  const pod = podName("notif-worker", rng);
  const lag = rng.int(60, 450) * 1000;
  const logs = [
    `${logTs(startedAt, -80, rng)} INFO kafka-${rng.int(0, 2)} [GroupCoordinator ${rng.int(0, 2)}]: Preparing to rebalance group notif-worker in state PreparingRebalance with old generation ${rng.int(300, 990)} (reason: member ${pod} has left group)`,
    `${logTs(startedAt, -61, rng)} INFO ${pod} [Consumer clientId=${pod}, groupId=notif-worker] Revoke previously assigned partitions payment.events-${rng.int(0, 5)}, payment.events-${rng.int(6, 11)}`,
    `${logTs(startedAt, -44, rng)} ERROR ${pod} CommitFailedException: Commit cannot be completed since the group has already rebalanced; max.poll.interval.ms=300000 exceeded`,
    `${logTs(startedAt, -30, rng)} WARN ${pod} (Re-)joining group notif-worker; rebalance in progress (attempt ${rng.int(4, 19)})`,
    `${logTs(startedAt, -18, rng)} WARN ${pod} sms-provider call took ${rng.int(900, 2400)}ms (batch=${variant === 0 ? 5000 : 500})`,
    `${logTs(startedAt, -2, rng)} INFO burrow consumer_group=notif-worker topic=payment.events total_lag=${fmtInt(lag)} status=STALL`,
  ];
  const failed = rng.shuffle([
    { fix: "scaled notif-worker to 30 replicas", why: `only ${partitions} partitions; extra members just triggered more rebalances` },
    { fix: "reset consumer group offsets to latest", why: `would skip ~${fmtInt(lag)} payment notifications; destructive, needed approval and was reverted` },
    { fix: "restarted notif-worker pods", why: "every restart kicked off another rebalance" },
  ]).slice(0, rng.int(1, 2));
  return {
    title: "notif-worker consumer lag — payment SMS delayed",
    service: "notif-worker",
    severity: rng.pick(["SEV2", "SEV3"] as const),
    alert: alertOf({
      alertname: rng.pick(["KafkaConsumerLagHigh", "NotificationDeliveryDelayHigh"]),
      service: "notif-worker",
      severity: "SEV2",
      summary: `notif-worker lag on payment.events ${fmtInt(lag)} msgs; payment SMS delayed ${rng.int(8, 45)} min`,
      description: "Consumer group notif-worker is stalled; customers not receiving debit confirmations.",
      expr: 'sum(kafka_consumergroup_lag{consumergroup="notif-worker",topic="payment.events"}) > 50000',
      value: `${lag}`,
      startsAt: startedAt,
      extraLabels: { consumergroup: "notif-worker", topic: "payment.events" },
    }),
    logs,
    change: c,
    rootCause: `${triggers[variant]} (${c.sha ?? "infra"}). Consumers exceeded max.poll.interval.ms or were revoked repeatedly, putting notif-worker into a partition-rebalance loop so lag on payment.events kept growing.`,
    fixThatWorked: rng.pick([
      "reverted max.poll.records to 500, switched to CooperativeStickyAssignor and enabled static membership (group.instance.id); lag drained in 25 min",
      `pinned notif-worker replicas to ${partitions} (= partitions), enabled static membership and raised max.poll.interval.ms to 600s`,
    ]),
    fixesThatFailed: failed,
    eureka: "rebalance storm — generation keeps bumping, commits failing on max.poll.interval.ms",
    impact: `${fmtInt(lag)} payment notifications delayed up to ${rng.int(20, 70)} min; support tickets spiked.`,
    actionItems: ["Cooperative rebalancing for all consumers", "Alert on consumer group generation churn", "Replica cap = partition count"],
  };
}

// ------------------------------------------------------------------ TLS / secrets

function tls({ rng, startedAt }: Ctx): Scenario {
  const variant = rng.int(0, 3);
  const service = variant === 3 ? "upi-gateway" : "auth-svc";
  const triggers = [
    "cert-manager failed to renew the auth.paynest.in certificate (DNS-01 challenge denied after an IAM policy change)",
    "Vault rotated the JWT signing key (kid rolled); auth-svc kept serving a cached JWKS without the new kid",
    "Vault rotated the auth-svc postgres credentials; running pods kept the expired lease",
    "mTLS client certificate used by upi-gateway to talk to NPCI expired",
  ];
  const c = change(
    rng,
    startedAt,
    variant === 0 ? "none" : "secret-rotation",
    service,
    variant === 0 ? "none" : triggers[variant]!,
    rng.int(30, 1440),
  );
  const pod = podName(service, rng);
  const expiry = startedAt.slice(0, 10) + "T00:00:00Z";
  const logs = [
    variant === 1
      ? `${logTs(startedAt, -60, rng)} WARN payments-api-${rng.hex(9)} 401 from auth-svc /v1/token/introspect: invalid signature (kid=paynest-${rng.hex(4)})`
      : `${logTs(startedAt, -60, rng)} ERROR ${pod} x509: certificate has expired or is not yet valid: current time ${startedAt} is after ${expiry}`,
    variant === 2
      ? `${logTs(startedAt, -44, rng)} FATAL ${pod} password authentication failed for user "v-auth-svc-${rng.hex(6)}"`
      : `${logTs(startedAt, -44, rng)} ERROR ${pod} tls: failed to verify certificate: x509: certificate signed by unknown authority`,
    variant === 0
      ? `${logTs(startedAt, -35, rng)} E cert-manager/orders "msg"="Failed to finalize order" "error"="acme: authorization error for auth.paynest.in: 403 urn:ietf:params:acme:error:unauthorized"`
      : `${logTs(startedAt, -35, rng)} INFO vault audit: rotate path=${variant === 3 ? "pki/issue/npci-client" : variant === 1 ? "transit/keys/jwt-signing" : "database/creds/auth-svc"}`,
    `${logTs(startedAt, -20, rng)} WARN ${service === "auth-svc" ? "payments-api" : "upi-gateway"}-${rng.hex(9)} ${service === "auth-svc" ? "auth failures 401/403 ratio 64%" : "NPCI handshake failure: remote error: tls: bad certificate"}`,
    `${logTs(startedAt, -8, rng)} ERROR ${pod} readiness probe failed: ${variant === 2 ? "db connect" : "TLS handshake"} error`,
    `${logTs(startedAt, 3, rng)} INFO blackbox-exporter probe_ssl_earliest_cert_expiry{instance="${service === "auth-svc" ? "auth.paynest.in:443" : "npci-client"}"} ${variant === 0 || variant === 3 ? "-" : ""}${rng.int(100, 90000)}`,
  ];
  const failed = rng.shuffle([
    { fix: `rolled back the last ${service} deploy`, why: "the credential is not in the image; no change" },
    { fix: `restarted ${service} pods`, why: "pods re-mounted the same stale Secret (ExternalSecret had not synced)" },
  ]).slice(0, rng.int(0, 2));
  const fixes = [
    "renewed the cert with `cmctl renew auth-paynest-in`, restored Route53 IAM permission for cert-manager DNS-01",
    "forced JWKS refresh on auth-svc (POST /admin/jwks/reload) and set JWKS cache TTL to 5 min",
    "forced ExternalSecret resync and rolling restart of auth-svc so pods picked up new Vault DB creds",
    "issued a new NPCI mTLS client cert from Vault PKI, updated the secret and reloaded upi-gateway",
  ];
  return {
    title: `${service} auth failures — ${variant === 0 ? "expired TLS certificate" : "rotated secret not picked up"}`,
    service,
    severity: "SEV1",
    alert: alertOf({
      alertname: rng.pick(["AuthFailureSpike", "BlackboxProbeFailed", "SSLCertExpired"]),
      service,
      severity: "SEV1",
      summary: `${service} ${service === "auth-svc" ? "login/token failures" : "NPCI handshake failures"} ${rng.int(40, 95)}%`,
      description: `Probe to ${service} failing; downstream 401/403 spike.`,
      expr: service === "auth-svc" ? "sum(rate(auth_token_failures_total[5m])) > 200" : "probe_success{job=\"npci-mtls\"} == 0",
      value: `${rng.int(200, 2400)}`,
      startsAt: startedAt,
    }),
    logs,
    change: c,
    rootCause: `${triggers[variant]}. ${service} failed TLS/auth for every dependent call.`,
    fixThatWorked: fixes[variant]!,
    fixesThatFailed: failed,
    eureka: variant === 1 ? "kid mismatch — JWKS cache is stale after the Vault key rotation" : "cert/secret expired — this is a credential problem, not code",
    impact: `${rng.int(12, 60)} min of failed logins/payments; ${fmtInt(rng.int(10000, 90000))} users affected.`,
    actionItems: ["Alert 14 days before any cert expiry", "Rotations must trigger ExternalSecret sync + rolling reload", "Runbook: credential incidents never need a code rollback"],
  };
}

// ------------------------------------------------------------------ Config / flags

function badConfig({ rng, startedAt }: Ctx): Scenario {
  const variant = rng.int(0, 3);
  const flags = [
    { name: "enable_fee_engine_v2", err: "KeyError: 'merchant_fee_bps' in fee_engine_v2.compute()" },
    { name: "upi_intent_v2", err: "TypeError: 'NoneType' object has no attribute 'mdr_slab'" },
    { name: "ratelimit.max_rps", err: "429 Too Many Requests: limit=50 rps (expected 5000)" },
    { name: "ledger_svc_url", err: "ConnectionError: HTTPConnectionPool(host='ledger-svc.payments.svc.cluster.loca', port=8080): Name or service not known" },
  ];
  const f = flags[variant]!;
  const descriptions = [
    `Unleash flag ${f.name} flipped to 100% rollout (default rule) instead of 5% canary`,
    `Unleash flag ${f.name} enabled for all merchants, incl. those missing MDR slab config`,
    `payments-api-config ConfigMap push set ${f.name}=50 (typo, meant 5000)`,
    `payments-api-config ConfigMap push with typo in ${f.name} (".cluster.loca")`,
  ];
  const c = change(rng, startedAt, variant < 2 ? "feature-flag" : "config", "payments-api", descriptions[variant]!, rng.int(3, 25));
  const pod = podName("payments-api", rng);
  const logs = [
    `${logTs(startedAt, -50, rng)} INFO unleash-proxy flag=${f.name} strategy=default rollout=100% updatedBy=${c.author}`,
    `${logTs(startedAt, -38, rng)} ERROR ${pod} [req=${reqId(rng)}] POST /v1/payments/collect 500 ${f.err}`,
    `${logTs(startedAt, -30, rng)} ERROR ${pod} [req=${reqId(rng)}] POST /v1/payments/collect 500 ${f.err}`,
    `${logTs(startedAt, -19, rng)} WARN ${pod} sentry: new issue ${rng.hex(8)} "${f.err.slice(0, 60)}" events=${rng.int(2000, 40000)}`,
    `${logTs(startedAt, -7, rng)} INFO ${pod} db pool ok active=${rng.int(4, 9)}/20; redis ok; upstreams healthy`,
    `${logTs(startedAt, 1, rng)} WARN envoy [payments] 5xx ratio payments-api ${rng.int(12, 48)}%`,
  ];
  const failed = rng.shuffle([
    { fix: "rolled back the last payments-api image deploy", why: "no effect — the change was runtime config, not code" },
    { fix: "restarted payments-api pods", why: "flag/config re-evaluated identically on boot" },
    { fix: "scaled payments-api up", why: "errors are deterministic per request; more pods = more 500s" },
  ]).slice(0, rng.int(1, 2));
  return {
    title: `payments-api 5xx after ${variant < 2 ? "feature flag" : "config"} push`,
    service: "payments-api",
    severity: rng.pick(["SEV1", "SEV2"] as const),
    alert: alertOf({
      alertname: "PaymentsAPIHigh5xxRate",
      service: "payments-api",
      severity: "SEV1",
      summary: `payments-api 5xx ratio above 5% (${rng.int(12, 48)}%)`,
      description: "5xx concentrated on POST /v1/payments/collect.",
      expr: 'sum(rate(http_requests_total{service="payments-api",code=~"5.."}[5m])) / sum(rate(http_requests_total{service="payments-api"}[5m])) > 0.05',
      value: ratio(rng, 12, 48),
      startsAt: startedAt,
    }),
    logs,
    change: c,
    rootCause: `${descriptions[variant]} (change ${c.sha} by ${c.author}). Every request on the affected path failed deterministically with "${f.err.slice(0, 70)}".`,
    fixThatWorked:
      variant < 2
        ? `turned off ${f.name} in Unleash (kill switch); 5xx dropped to baseline within 90s`
        : `reverted payments-api-config ConfigMap to the previous revision (kubectl rollout undo is not enough; re-applied config ${rng.hex(7)}) and reloaded`,
    fixesThatFailed: failed,
    eureka: `${f.name} change ${c.sha} at ${c.at?.slice(11, 16)}Z lines up exactly with the first 500s. it's config, not the image`,
    impact: `${fmtInt(rng.int(8000, 70000))} collect requests failed over ${rng.int(9, 40)} min.`,
    actionItems: ["Flags must start at <=5% rollout", "Config schema validation in CI", "Record config pushes as Grafana annotations"],
  };
}

export const FAMILY_GENERATORS: Record<Family, (ctx: Ctx) => Scenario> = {
  "db-pool-exhaustion": dbPool,
  "redis-eviction-storm": redis,
  "npci-bank-timeout": npci,
  "kafka-consumer-lag": kafka,
  "tls-secret-expiry": tls,
  "bad-config-push": badConfig,
};
