# Bounded queue companion

Status, October 27, 2026: **implemented and deployed** with an EN/RU touch search keyboard. This file preserves the integration boundary and records its validation. Physical Pi acceptance remains open.

The approved MA Browser Card `v3.11.2` provides library search, play-now, play-next, enqueue, queue inspection/jump, and queue clear. Its pinned source has no individual remove/reorder controls. It also cannot inspect SHIELD's MA queue while that player uses external Spotify (`active_queue: null` in HA).

The upstream card remains unchanged. One small repository-owned `home-console-queue` card sits on **Music Library**, below the browser. This is the bounded integration allowed by the music feasibility gate. It adds no package or runtime dependency and preserves the six views.

- Read `input_select.pi_console_player` and map only the four confirmed HA entities to their registry-verified MA player IDs.
- Use the same non-admin, four-player-restricted MA identity through supported HA ingress.
- Show the MA queue even when it is inactive; label that state. Never select a source or start playback during inspection.
- Offer Move up, Move down, and Remove for upcoming items. Keep the current item/history read-only; existing Next handles skipping playback.
- Use stable queue-item IDs. Recheck the selected target before every mutation and discard responses from a previous room.
- Poll only while the queue is open. Release timers and requests when detached. A missing/unavailable entity disables actions; it never selects a fallback player.
- Prevent queue gestures from reaching Swipe Navigation. Keep normal vertical scrolling inside the queue.
- Store tokens only in private HA configuration/operator snapshots. Sanitized exports omit them.

## Validation

- Automated policy checks cover absent/unknown/unavailable targets, wrong-room mutation rejection, current/history protection, stable IDs, pagination boundaries, secret stripping, and published module imports.
- The restricted MA user can read exactly four players and their queues; administrator access is denied. Ordinary `pi-kiosk` browser login and live queue loading succeeded.
- A live Bedroom test started Radio Paradise through the console. The user confirmed: **"Yes, clear audio"**. Enqueueing Global/Mellow, moving Global upward, and removing upcoming Mellow changed the actual queue as expected. Current playback remained intact.
- Selecting Denon while Bedroom played preserved Bedroom playback, queue order, and 20% volume. Cleanup stopped only the test playback and restored the originally empty Bedroom queue. Final readback confirmed idle, zero items, and 20% volume.
- Browser checks exercised English `Bach` and Russian `Аквариум` through on-screen keys, including shift, backspace, clear, submit, and dismissal. The keyboard appears only for MA search on the dedicated `?kiosk` URL. Ordinary HA navigation stays visible without that parameter.
- Twelve synthetic touch swipes completed the six-view loop in both directions and retained `?kiosk`. These were browser tests at `1024×600`, not physical Pi input tests.

Later acceptance verified the actual card's Play now, Play next, and Add to queue actions, followed by the user-approved Bedroom-to-Denon transfer and restoration. Isolated real Chromium tests verified absent/unavailable targets and visible 403/500 failures. On the actual Pi browser, touch injection entered EN/RU searches; slider and companion drags retained their current view. The final dashboard uses `prevent_default: true` to prevent native browser horizontal gestures competing with swipe navigation. Full twelve-swipe retesting passed.

Physical night wake passed with user confirmation: the first touch wakes, the second acts normally, and logs confirm the 120-second return to darkness. The user later confirmed physical six-view swipes, EN/RU search, and no visible pointer. Actual Pi vertical touch gestures retained their view/room, and a real Bedroom queue stayed playing through Music Library → Players → Radio → UPS at verified zero volume. Fresh state was restored afterward. WiiM playback cleared mute in the first attempt; the corrected quiet test uses zero volume before starting playback.

Still open: supported grouping, deferred because the user requested keeping TV/Denon off, and the running memory/stability observation. Policy tests do not prove network cancellation under every timing race. No card fork or transfer on room selection was introduced. See the current [implementation record](IMPLEMENTATION_STATUS.md) for measurements and private evidence locations.
