# NEXUS Usability Test Plan

## Scope and result policy

This plan evaluates the operator workflows supported by the current serial-to-
HTTP gateway, SQLite event history, Socket.IO stream, and React dashboard. It
does not assume a device registry, protocol manager, user accounts, alerts,
data export, or event-resolution workflow exists.

**Execution status:** partial browser validation only. The local Vite dashboard
was opened without a running gateway; it correctly showed an unavailable
gateway and unavailable history after the dev proxy returned HTTP `502`. At a
390 × 844 browser viewport, the rendered page had no horizontal overflow. No
workflow below was completed against a running gateway, physical hardware, or
mobile device. Expected results are test targets, not passes. Do not change a
status to `PASS` without completing the workflow and checking its evidence.

### Result record

For each workflow, capture:

- **Preconditions** — required services, data, and equipment.
- **User actions** — the steps actually performed.
- **Expected result** — intended observable behavior.
- **Actual result** — what happened, including timing and data freshness.
- **Errors encountered** — exact user-visible message and whether state changed.
- **Verification evidence** — screenshots, HTTP responses, logs, and/or saved
  records, with secrets redacted.
- **Final status** — `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`, or
  `NOT APPLICABLE (unsupported)`.

## Workflow A — First-time setup

- **Preconditions:** Node.js 22.13+, npm, Python 3 and bridge dependencies;
  the gateway and dashboard dependencies installed.
- **User actions:** Follow the Windows local-development steps in the root
  README; start the gateway and dashboard; open the Vite URL; inspect System
  status; then start the bridge if hardware is available.
- **Expected result:** The dashboard distinguishes a gateway/database health
  check from the live Socket.IO connection. An empty feed explains how to
  start the gateway and serial bridge, and links to status diagnostics.
- **Actual result:** Dashboard-only browser check completed. The empty
  overview rendered with `GATEWAY UNAVAILABLE`, history-unavailable guidance,
  and a retry action. Setup with the gateway and bridge was not completed.
- **Errors encountered:** The dev proxy returned HTTP `502` for health and
  history while the gateway was stopped; the page reported the failure.
- **Verification evidence:** Integrated browser snapshot of
  `http://127.0.0.1:5173/`; no gateway response was available. Reference
  procedure: [README local development](../README.md#local-development-on-windows).
- **Final status:** `NOT RUN`.

## Workflow B — Add a device

- **Preconditions:** Current implementation.
- **User actions:** Look for a device-registration workflow in the dashboard
  and gateway API.
- **Expected result:** A supported registration workflow would validate and
  persist a device without source-code or database edits.
- **Actual result:** No device registry or registration endpoint is
  implemented. The bridge currently sends the configured `deviceId` from
  `serial_bridge.py`.
- **Errors encountered:** Registration cannot be performed in the current
  application.
- **Verification evidence:** Code inspection only; no runtime test.
- **Final status:** `NOT APPLICABLE (unsupported)`.

## Workflow C — Verify communication

- **Preconditions:** Gateway and dashboard running; optionally a connected
  serial bridge or a test sender.
- **User actions:** Open System status and confirm the gateway health check;
  submit a test event using the NSP TLS 1.3/mTLS client (or trigger an Arduino
  motion event through the authenticated serial bridge); inspect the ACK,
  live feed, and saved event history. Then stop the dashboard's gateway
  connection and compare the API and stream indicators.
- **Expected result:** The gateway ACK follows the SQLite commit; the live
  feed updates only when a Socket.IO event is received. API health and stream
  state are shown separately. Unauthenticated HTTP event submission returns
  HTTP `410`.
- **Actual result:** Not run.
- **Errors encountered:** None recorded; test not run.
- **Verification evidence:** None collected. During execution, save the POST
  response, corresponding `GET /api/events` record, and dashboard screenshot.
- **Final status:** `NOT RUN`.

## Workflow D — Monitor data

- **Preconditions:** At least one stored event; gateway and dashboard running.
- **User actions:** Review the latest event and loaded event count; open Event
  history; filter by GPS availability or event type; inspect a row and its map
  link where coordinates are valid.
- **Expected result:** The interface shows the gateway receive timestamp,
  device identifier when supplied, valid coordinates only, and helpful empty
  states. Counts represent records loaded in the browser, not a database-wide
  total.
- **Actual result:** Not run.
- **Errors encountered:** None recorded; test not run.
- **Verification evidence:** None collected. Current history loads at most
  100 records from the API by default; browser memory is capped at 500.
- **Final status:** `NOT RUN`.

## Workflow E — Investigate a failure

- **Preconditions:** Gateway stopped or database unavailable; dashboard open.
- **User actions:** Open System status, observe health and stream indicators,
  read the suggested next step, then retry the check after restoring the
  service.
- **Expected result:** Gateway unavailability is distinct from a database
  degradation and from a disconnected live stream. The UI does not report
  health based only on loading the frontend.
- **Actual result:** Partial failure-state check only. With the gateway stopped,
  the dashboard reported the health request as HTTP `502`, showed the API as
  offline, and showed live updates as disconnected. Recovery was not tested.
- **Errors encountered:** HTTP `502` from the Vite proxy because no gateway was
  listening.
- **Verification evidence:** Integrated browser System status snapshot;
  timestamp displayed by the app. Capture statuses before, during, and after
  recovery when the full test is run.
- **Final status:** `NOT RUN`.

## Workflow F — Configure a protocol

- **Preconditions:** Current implementation.
- **User actions:** Look for a protocol configuration view and try to save a
  supported protocol connection.
- **Expected result:** A real adapter would validate protocol-specific
  configuration and explain connection-test results.
- **Actual result:** The current application only supports the Arduino serial
  bridge, HTTP ingestion, and Socket.IO delivery; there is no protocol
  configuration UI or MQTT/CoAP adapter.
- **Errors encountered:** No configuration action is available.
- **Verification evidence:** Code inspection only; no runtime test.
- **Final status:** `NOT APPLICABLE (unsupported)`.

## Workflow G — Inspect an event

- **Preconditions:** Stored event with valid GPS coordinates and, separately,
  an event without valid coordinates.
- **User actions:** Find each event in the history, compare its device and
  receive timestamp, and open the mapped event in the map or external map link
  when coordinates are valid.
- **Expected result:** The map includes only valid coordinates and its popup
  identifies event, device, receive time, coordinates, and satellite count.
  An event without coordinates remains visible in history and is not plotted.
- **Actual result:** Not run.
- **Errors encountered:** None recorded; test not run.
- **Verification evidence:** None collected. Map tile availability depends on
  OpenStreetMap and is not currently monitored by the dashboard.
- **Final status:** `NOT RUN`.

## Workflow H — Recover from a connection failure

- **Preconditions:** Dashboard connected to a running gateway.
- **User actions:** Interrupt and restore the gateway connection; observe the
  Socket.IO indicator, periodic API health check, history refresh, and arrival
  of a new event after recovery.
- **Expected result:** Disconnection is visible; restoring the service returns
  the API and live-stream indicators to their actual states, and saved history
  can be retried without reloading the page.
- **Actual result:** Not run.
- **Errors encountered:** None recorded; test not run.
- **Verification evidence:** None collected. Record disconnect/reconnect times
  and a post-recovery test event.
- **Final status:** `NOT RUN`.

## Workflow I — Export data

- **Preconditions:** Current implementation.
- **User actions:** Look for a way to export only the records selected by the
  current filters.
- **Expected result:** A supported export would contain only the chosen
  non-sensitive fields and the selected subset.
- **Actual result:** The dashboard does not currently provide event export.
- **Errors encountered:** No export action is available.
- **Verification evidence:** Code inspection only; no runtime test.
- **Final status:** `NOT APPLICABLE (unsupported)`.

## Workflow J — Use the application on mobile

- **Preconditions:** A phone or browser device emulator; gateway data available.
- **User actions:** At a narrow viewport, navigate all sections, inspect
  history filters, open the event map, read System status, and use all visible
  controls by touch and keyboard where available.
- **Expected result:** Navigation remains reachable, controls remain usable,
  tables can be horizontally scrolled, map content fits the viewport, and
  focus is visible during keyboard navigation.
- **Actual result:** Partial viewport check only. At 390 × 844, the rendered
  document body had matching 375px scroll and client widths. The complete
  device/event/map workflow, touch targets, and keyboard operation were not
  tested.
- **Errors encountered:** None observed in the viewport-width check.
- **Verification evidence:** Integrated browser viewport check; record
  screenshots and any clipped or unreachable controls during full execution.
- **Final status:** `NOT RUN`.

## Capability gaps to revisit

- Add and manage registered devices; distinguish registered identity from
  recently observed telemetry.
- Add protocol configuration only when adapters and backend validation exist.
- Add per-device details, telemetry trends, time-range queries, and safe
  filtered export when storage/query behavior supports them.
- Add meaningful event severity, acknowledgement, and resolution only with
  persistent state and authorization.
- Test reconnect and mobile behavior with a running deployment before claiming
  those workflows pass.
