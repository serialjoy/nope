# Band 58 Bluetooth audit · November 14, 2026

The detector serves the organizers’ Vexo JavaScript SDK byte for byte. The monitor change kept the same Bluetooth connection function. Chrome later reported `GATT Server is disconnected. Cannot retrieve services` and a read timeout. The GATT error occurs during service discovery, before the detector configures its audio or motion streams. The timeout and the reason for the link loss remain unresolved.

## Timeline (Pacific time)

- **4:43 p.m.** All 10 local SDK copies have a filesystem modification time of 4:43:40 p.m.
- **4:45 p.m. · `261db41`** Connected detections to the app’s intervention flow. The connection function matched the initial browser detector at `fdbf3cb`.
- **4:52 p.m. · `6fdce8d`** Changed app cleanup after errors and disconnects. It added a check that a disconnect belongs to the current band session, closed a band after setup failed, and prevented stale model results from reporting against a new session. The Bluetooth options and stream settings stayed the same.
- **4:54–5:17 p.m.** Live lighter detections were observed from band 58. At **5:12 p.m.**, `c733425` added the motion monitor and changed the sound decision rules. Its `connect()` function is byte for byte identical to `6fdce8d`. Chrome later showed a lost link and a GATT service discovery failure on the older detector page.
- **5:25 p.m. · `d4a5f34`** Added a USB option and blocked overlapping connection attempts in the page. A Bluetooth click still uses `Band.connect(58, {})`. USB passes `{ transport: "serial" }`. Both request `{ motion: 50, sensors: "both", audio: true }` after the SDK connects.

## What the browser uses

The detector imports `/vendor/vexo/index.js`. The tracked setup script copies JavaScript directly from the sibling `vexo-open-kit/js/src` tree to `public/vendor/vexo`. The app ignores `public/vendor/` in Git, so the audit compared the files on disk directly. The kit checkout was clean at `1e4291e2fa4896b1f603d3d4f0b009c483425da0`. The served `band.js`, `web-bluetooth.js`, `page.mjs`, and `detector.html` also matched their disk copies and returned `Cache-Control: no-store`.

The copied SDK filters the chooser by `Vexo-HACK-58` and service UUID `254f0001-df82-4a9c-a2b5-563a0f6b2021`. The kit’s optional `listAll` setting defaults to `false` and the detector never enables it. The SDK then connects GATT, resolves the service and RX/TX characteristics, and starts notifications. `Band.connect` reads the reported band number and disconnects on a mismatch. The detector subscribes and starts streams only after `Band.connect` succeeds. Relevant code is in `scripts/setup-detector.mjs`, `public/detector/page.mjs`, and the copied `transports/web-bluetooth.js` and `band.js`.

The same SHA-256 hashes apply to both trees. The sorted manifest below has SHA-256 `d11565b049871d988bb2468c4dfe3e395da59504837564b1aa7ac48a66456ac8`.

```text
16762b88d48ae0e3c4280a2e90e4addb881820f6c4bc42ead2f809090bdad58d  audio.js
1d275a530b42f77ce4534d1269e40ffd877e58dea90e221837c63e0324e0c549  band.js
97658aa7088f813e37f2ddb377a90257c1008a316477f3f145c04fa0d7916a85  codec.js
ba6c6c1b4c424a0aaa247e9f5f2b2b655f341535eaf5c4dee1c9fd91ba187a2b  index.js
c1ade474001595e2807348101926d06ea626974b6c4d3a95383e800da7d35b48  stream-watch.js
c27c99ee1771d578116e0037b0e49fbaa27974a3c70912f0e35e8afff2521a12  transport.js
1c5cb3ee5a3e050afd736682ae4a00281ef7ee3bed25866518e4e1416cae052c  transports/session-watch.js
4f2e287510142657047376aaf14b6242a6e6ecd8b48216d6b2794e684347a0a8  transports/sim.js
c4c94965563d3d8185e56300480f88dd7f0c4a71e1659d478039bcc2139e81f9  transports/web-bluetooth.js
29d7c2d63968facb878995495cdfbddc8c53bffc53610d8d12fe6ba418fc7c88  transports/web-serial.js
```

## Next check

Use `/band-check.html` in one Chrome tab with other band clients disconnected. Start with the SDK connection to band 58 alone. That will help determine whether service discovery also fails without the detector’s microphone, model, or event reporting. This page has yet to be tested on the physical band. The user subsequently reported that their connection was working again; its recovery cause has not been established, and the working connection was left running.
