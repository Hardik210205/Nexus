# Nexus benchmark methodology

## Status

No benchmark harness or performance results exist in the current repository.
No latency, throughput, resource-use, or protocol-efficiency claim is made.
This document defines a repeatable method for later measurements.

## Comparisons

Run HTTP baseline and NSP/TCP/TLS only after the NSP service is integrated.
Add MQTT and CoAP only after complete, documented adapters exist. Never
compare an in-process codec with a networked secure service or compare
different event schemas without calling out the difference.

## Workload and controls

- Use the same canonical event payload, including GPS and no-GPS cases, for
  each adapter.
- Record client count, concurrent connections, connection reuse, event rate,
  payload/frame bytes, TLS version/cipher configuration, MQTT QoS/retention,
  CoAP security/reliability mode, and timeout/retry behavior.
- Record exact hardware/CPU, memory, OS/kernel, compiler/runtime, dependency
  versions, gateway/database configuration, network topology, and power mode.
- Warm up the service, then run a fixed-duration measurement for at least
  five independent repetitions with isolated database state or a documented
  reset process.
- Preserve identical durability/ACK semantics; a non-durable fast path is not
  comparable to commit-before-ACK.

## Measurements

Collect per-message end-to-end and service processing latency (median, P95,
P99), successful messages/second, failed-message rate, CPU and resident memory,
bytes transmitted per accepted event, connection setup time, TLS handshake
time, persistence time, and behavior as concurrency increases. Separate cold
connection from reused-connection measurements. Include duplicate retries
and database backpressure scenarios.

Use monotonic clocks for local intervals and state clock synchronization for
cross-host timings. Use enough observations for reported quantiles and publish
raw machine-readable results with scripts and invocation parameters. Do not
fabricate or extrapolate absent measurements.

## Reporting and acceptance

Each report must state test date, environment, versions, configuration,
workload, warm-up, duration, repetitions, sample count, failures, and known
confounders. Treat this as a baseline first; optimize only after identifying
measured bottlenecks. A result applies only to the tested configuration and
does not prove production capacity or security.
