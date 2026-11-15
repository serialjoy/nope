import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { BAND_NUMBER, DEFAULT_PORT } from "./config.mjs";
import { BEHAVIORS, isBehaviorId } from "./lib/behavior-catalog.mjs";
import { BehaviorClassifier } from "./lib/classifier.mjs";
import { CorrectionsEngine } from "./lib/corrections.mjs";
import { HttpError, isHttpError } from "./lib/errors.mjs";
import { GeminiClient } from "./lib/gemini.mjs";
import { StripePayments } from "./lib/payments.mjs";
import {
  buildDemoClarification,
  buildDemoPlan,
  clarificationFromGemini,
  planFromGemini,
} from "./lib/planner.mjs";
import { RulesStore } from "./lib/rules-store.mjs";
import { RecordingsStore } from "./lib/recordings-store.mjs";
import {
  requireObject,
  requiredText,
  buildCompactRule,
  GRACE_SECONDS,
  isCompactRulePayload,
  PENALTY_AMOUNTS,
  validateDetectorEvent,
  validateCompactRuleDraft,
  validateCompactRulePatch,
  validateDetectorStop,
  validateRuleDraft,
  validateRulePatch,
} from "./lib/validation.mjs";

const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIRECTORY = path.join(MODULE_ROOT, "public");
const DEFAULT_DATA_DIRECTORY = path.join(MODULE_ROOT, ".data");
const MAX_BODY_BYTES = 32 * 1024;
const KEEPALIVE_MS = 25_000;
const RECORDING_STATUSES = new Set(["recording", "recorded", "cancelled"]);

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".onnx", "application/octet-stream"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

async function readJson(request) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large.");
  }
  let received = 0;
  const chunks = [];
  try {
    for await (const chunk of request) {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) throw new HttpError(413, "Request body is too large.");
      chunks.push(chunk);
    }
  } catch (error) {
    if (isHttpError(error)) throw error;
    throw new HttpError(400, "Could not read request body.");
  }
  if (!chunks.length) throw new HttpError(400, "Request body is required.");
  try {
    return requireObject(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (isHttpError(error)) throw error;
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function routeRuleId(pathname) {
  const match = pathname.match(/^\/api\/rules\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function routeRuleStopId(pathname) {
  const match = pathname.match(/^\/api\/rules\/([^/]+)\/stop$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function routeRecordingId(pathname) {
  const match = pathname.match(/^\/api\/recordings\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function validateRecordingCreate(value) {
  const body = requireObject(value);
  const allowed = new Set(["description", "behaviorId"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "Only description and behaviorId can be used to request a recording.");
  }
  const behaviorId = own(body, "behaviorId") ? body.behaviorId : null;
  if (behaviorId !== null && !isBehaviorId(behaviorId)) {
    throw new HttpError(400, "behaviorId must be a supported habit or null.");
  }
  return {
    description: requiredText(body.description, "description"),
    behaviorId,
  };
}

function validateRecordingTransition(value) {
  const body = requireObject(value);
  const allowed = new Set(["bandNumber", "status", "recordingRef", "sampleCount"]);
  if (!Object.keys(body).length || Object.keys(body).some((key) => !allowed.has(key))) {
    throw new HttpError(400, "Only bandNumber, status, recordingRef, and sampleCount can update a recording.");
  }
  if (!own(body, "bandNumber") || body.bandNumber !== BAND_NUMBER) {
    throw new HttpError(400, `This server only accepts recording updates for band ${BAND_NUMBER}.`);
  }
  if (!own(body, "status") || !RECORDING_STATUSES.has(body.status)) {
    throw new HttpError(400, "status must be recording, recorded, or cancelled.");
  }

  const hasCompletionMetadata = own(body, "recordingRef") || own(body, "sampleCount");
  if (body.status !== "recorded") {
    if (hasCompletionMetadata) {
      throw new HttpError(400, "recordingRef and sampleCount are only allowed when status is recorded.");
    }
    return {
      status: body.status,
      recordingRef: null,
      sampleCount: null,
    };
  }

  const recordingRef = requiredText(body.recordingRef, "recordingRef", 240);
  if (!Number.isInteger(body.sampleCount) || body.sampleCount < 1 || body.sampleCount > 1_000_000) {
    throw new HttpError(400, "sampleCount must be an integer from 1 to 1000000.");
  }
  return {
    status: "recorded",
    recordingRef,
    sampleCount: body.sampleCount,
  };
}

function sameLoopbackOrigin(request, origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  const address = request.socket.localPort;
  return parsed.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
    && Number(parsed.port) === address;
}

function isMutation(method) {
  return method === "POST" || method === "PATCH" || method === "DELETE";
}

function safeFilePath(publicDirectory, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  if (!relativePath || relativePath.split("/").some((part) => part.startsWith("."))) return null;
  const target = path.resolve(publicDirectory, relativePath);
  const prefix = `${publicDirectory}${path.sep}`;
  return target.startsWith(prefix) ? target : null;
}

async function serveStatic(response, publicDirectory, pathname, method) {
  if (method !== "GET" && method !== "HEAD") {
    sendError(response, 405, "Method not allowed.");
    return;
  }
  const target = safeFilePath(publicDirectory, pathname);
  if (!target) {
    sendError(response, 404, "Not found.");
    return;
  }
  let details;
  try {
    details = await stat(target);
  } catch {
    sendError(response, 404, "Not found.");
    return;
  }
  if (!details.isFile()) {
    sendError(response, 404, "Not found.");
    return;
  }
  response.writeHead(200, {
    "content-type": MIME_TYPES.get(path.extname(target).toLowerCase()) || "application/octet-stream",
    "content-length": details.size,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(target).pipe(response);
}

function apiMode(gemini) {
  return gemini.enabled ? "gemini" : "demo";
}

export function createApp({
  dataDirectory = process.env.END_ITT_DATA_DIR || DEFAULT_DATA_DIRECTORY,
  publicDirectory = PUBLIC_DIRECTORY,
  gemini = new GeminiClient({ apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL }),
  classifier = new BehaviorClassifier({
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_DECISION_MODEL,
  }),
  payments = null,
  clock = () => new Date(),
} = {}) {
  const store = new RulesStore(dataDirectory);
  const recordings = new RecordingsStore(dataDirectory);
  const clients = new Set();
  let server;
  let ownPayments = payments;

  function appOrigin() {
    const address = server?.address();
    const port = typeof address === "object" && address ? address.port : DEFAULT_PORT;
    return `http://127.0.0.1:${port}`;
  }

  function getPayments() {
    if (!ownPayments) {
      ownPayments = new StripePayments({
        secretKey: process.env.STRIPE_SECRET_KEY,
        dataDirectory,
        appOrigin: appOrigin(),
      });
    }
    return ownPayments;
  }

  const paymentService = {
    status: (...args) => getPayments().status(...args),
    createSetup: (...args) => getPayments().createSetup(...args),
    completeSetup: (...args) => getPayments().completeSetup(...args),
    prepareCharge: (...args) => {
      const service = getPayments();
      return typeof service.prepareCharge === "function"
        ? service.prepareCharge(...args)
        : { status: "ready", paymentSnapshot: null };
    },
    charge: (...args) => getPayments().charge(...args),
  };
  const corrections = new CorrectionsEngine({ store, payments: paymentService, now: clock });

  function nowIso() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    return date.toISOString();
  }

  async function presentRule(rule) {
    if (!rule) return rule;
    return { ...rule, warningArmed: await store.warningArmed(rule.id) };
  }

  function broadcastDetection(event) {
    const message = `event: detection\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (client.writableEnded || client.destroyed) {
        clients.delete(client);
      } else {
        client.write(message);
      }
    }
  }

  const keepalive = setInterval(() => {
    for (const client of clients) {
      if (client.writableEnded || client.destroyed) {
        clients.delete(client);
      } else {
        client.write(": keepalive\n\n");
      }
    }
  }, KEEPALIVE_MS);
  keepalive.unref();

  server = http.createServer(async (request, response) => {
    try {
      const method = request.method || "GET";
      const url = new URL(request.url || "/", "http://localhost");
      if (isMutation(method) && request.headers.origin && !sameLoopbackOrigin(request, request.headers.origin)) {
        throw new HttpError(403, "Cross-origin requests are not allowed.");
      }

      if (url.pathname === "/api/config" && method === "GET") {
        sendJson(response, 200, {
          bandNumber: BAND_NUMBER,
          aiMode: apiMode(gemini),
          model: gemini.model,
          behaviors: BEHAVIORS,
          penaltyAmounts: PENALTY_AMOUNTS,
          graceSeconds: GRACE_SECONDS,
          decisionModel: classifier.model,
          stripe: await paymentService.status(),
        });
        return;
      }

      if (url.pathname === "/api/classify" && method === "POST") {
        const body = await readJson(request);
        const description = requiredText(body.description, "description");
        const result = await classifier.classify(description);
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === "/api/clarify" && method === "POST") {
        const body = await readJson(request);
        const description = requiredText(body.description, "description");
        if (gemini.enabled) {
          const clarification = clarificationFromGemini(await gemini.clarify(description));
          sendJson(response, 200, { mode: "gemini", ...clarification });
        } else {
          sendJson(response, 200, { mode: "demo", ...buildDemoClarification(description) });
        }
        return;
      }

      if (url.pathname === "/api/plan" && method === "POST") {
        const body = await readJson(request);
        const input = {
          description: requiredText(body.description, "description"),
          clarification: requiredText(body.clarification, "clarification"),
          responsePlan: requiredText(body.responsePlan, "responsePlan"),
        };
        const rule = gemini.enabled
          ? planFromGemini(await gemini.plan(input), input)
          : buildDemoPlan(input);
        sendJson(response, 200, { mode: apiMode(gemini), rule });
        return;
      }

      if (url.pathname === "/api/recordings" && method === "GET") {
        sendJson(response, 200, { recordings: await recordings.list() });
        return;
      }

      if (url.pathname === "/api/recordings" && method === "POST") {
        const requestData = validateRecordingCreate(await readJson(request));
        const requestedAt = nowIso();
        const recording = await recordings.create({
          id: `recording_${randomUUID()}`,
          description: requestData.description,
          behaviorId: requestData.behaviorId,
          bandNumber: BAND_NUMBER,
          durationSeconds: 10,
          status: "requested",
          createdAt: requestedAt,
          updatedAt: requestedAt,
          recordingRef: null,
          sampleCount: null,
        });
        if (!recording) {
          throw new HttpError(409, "The 100 saved recording requests limit has been reached.");
        }
        sendJson(response, 201, { recording });
        return;
      }

      const recordingId = routeRecordingId(url.pathname);
      if (recordingId && method === "GET") {
        const recording = await recordings.get(recordingId);
        if (!recording) throw new HttpError(404, "Recording request not found.");
        sendJson(response, 200, { recording });
        return;
      }
      if (recordingId && method === "PATCH") {
        const change = validateRecordingTransition(await readJson(request));
        const result = await recordings.transition(recordingId, {
          status: change.status,
          recordingRef: change.recordingRef,
          sampleCount: change.sampleCount,
          updatedAt: nowIso(),
        });
        if (result.kind === "missing") throw new HttpError(404, "Recording request not found.");
        if (result.kind === "conflict") {
          throw new HttpError(409, "Recording request cannot make that state transition or change completion metadata.");
        }
        sendJson(response, 200, { recording: result.recording });
        return;
      }

      if (url.pathname === "/api/rules" && method === "GET") {
        const rules = await store.list();
        sendJson(response, 200, { rules: await Promise.all(rules.map((rule) => presentRule(rule))) });
        return;
      }

      if (url.pathname === "/api/rules" && method === "POST") {
        const body = await readJson(request);
        const submittedRule = body.rule ?? body;
        const identity = {
          id: `rule_${randomUUID()}`,
          enabled: true,
          createdAt: nowIso(),
        };
        const rule = isCompactRulePayload(submittedRule)
          ? await store.create(buildCompactRule(validateCompactRuleDraft(submittedRule), identity))
          : await store.create({ ...validateRuleDraft(submittedRule), ...identity });
        sendJson(response, 201, { rule: await presentRule(rule) });
        return;
      }

      const stopRuleId = routeRuleStopId(url.pathname);
      if (stopRuleId && method === "POST") {
        const stopped = await corrections.stop(stopRuleId, validateDetectorStop(await readJson(request)));
        sendJson(response, 200, {
          ok: true,
          episodeId: stopped.episode?.id ?? null,
          warningArmed: stopped.warningArmed,
        });
        return;
      }

      const ruleId = routeRuleId(url.pathname);
      if (ruleId && method === "PATCH") {
        const body = await readJson(request);
        const rule = await corrections.mutateRule(async (changedAt) => {
          const current = await store.get(ruleId);
          if (!current) throw new HttpError(404, "Rule not found.");
          if (isCompactRulePayload(body)) {
            const patch = validateCompactRulePatch(body);
            const change = patch.draft
              ? buildCompactRule(patch.draft, {
                id: current.id,
                enabled: patch.enabled ?? current.enabled,
                createdAt: current.createdAt,
              })
              : { enabled: patch.enabled };
            const endsEpisode = Boolean(patch.draft) || patch.enabled === false;
            return store.update(ruleId, change, {
              endActiveEpisodesAt: endsEpisode ? changedAt : null,
              endReason: patch.draft ? "rule_edited" : "rule_paused",
              resetWarning: Boolean(patch.draft) && patch.draft.behaviorId !== current.behaviorId,
            });
          }
          const change = validateRulePatch(body);
          return store.update(ruleId, change, {
            endActiveEpisodesAt: change.enabled === false ? changedAt : null,
            endReason: "rule_paused",
          });
        });
        sendJson(response, 200, { rule: await presentRule(rule) });
        return;
      }
      if (ruleId && method === "DELETE") {
        const removed = await corrections.mutateRule(async (changedAt) => {
          const current = await store.get(ruleId);
          if (!current) return false;
          await store.update(ruleId, { enabled: false }, {
            endActiveEpisodesAt: changedAt,
            endReason: "rule_deleted",
          });
          return store.remove(ruleId);
        });
        if (!removed) throw new HttpError(404, "Rule not found.");
        sendJson(response, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/payments/status" && method === "GET") {
        sendJson(response, 200, await paymentService.status());
        return;
      }
      if (url.pathname === "/api/payments/setup" && method === "POST") {
        await readJson(request);
        sendJson(response, 200, await paymentService.createSetup());
        return;
      }
      if (url.pathname === "/api/payments/complete" && method === "POST") {
        const body = await readJson(request);
        const sessionId = requiredText(body.sessionId, "sessionId", 240);
        sendJson(response, 200, await paymentService.completeSetup(sessionId));
        return;
      }

      if (url.pathname === "/api/events" && method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(": connected\n\n");
        clients.add(response);
        response.on("close", () => clients.delete(response));
        return;
      }

      if (url.pathname === "/api/events" && method === "POST") {
        const event = validateDetectorEvent(await readJson(request), BAND_NUMBER);
        const processed = await corrections.processEvent(event);
        if (!processed.duplicate) broadcastDetection(processed.event);
        sendJson(response, 200, { ok: true, event: processed.event });
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        sendError(response, 404, "Not found.");
        return;
      }
      await serveStatic(response, publicDirectory, url.pathname, method);
    } catch (error) {
      const status = isHttpError(error) ? error.status : 500;
      const message = isHttpError(error) ? error.message : "Something went wrong. Please try again.";
      if (!response.headersSent) sendError(response, status, message);
      else response.end();
    }
  });
  server.on("close", () => clearInterval(keepalive));
  return { server, store, recordings, broadcastDetection };
}

export function startServer({ port = Number(process.env.PORT) || DEFAULT_PORT } = {}) {
  const app = createApp();
  app.server.listen(port, "127.0.0.1", () => {
    const address = app.server.address();
    console.log(`End Itt is listening at http://127.0.0.1:${address.port}`);
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
