import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://api.stripe.com/v1";
const STRIPE_VERSION = "2026-10-28.endive";
const REQUEST_TIMEOUT_MS = 10_000;
const UNKNOWN_PAYMENT_RETENTION_MS = 23 * 60 * 60 * 1_000;
const ALLOWED_AMOUNTS = new Set([1, 5, 10]);
const TEST_KEY_PREFIXES = ["sk_test_", "rk_test_"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const EMPTY_STATE = Object.freeze({
  version: 1,
  customerId: null,
  paymentMethodId: null,
  cardLabel: null,
  pendingSetup: null,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isString(value) {
  return typeof value === "string" && value.length > 0;
}

function idFrom(value) {
  if (isString(value)) return value;
  if (value && typeof value === "object" && isString(value.id)) return value.id;
  return null;
}

function hasPrefix(value, prefix) {
  return isString(value) && value.startsWith(prefix);
}

function isTestKey(value) {
  return typeof value === "string" && TEST_KEY_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function isIdempotencyKey(value) {
  return typeof value === "string" && /^[\x21-\x7e]{1,255}$/.test(value);
}

function titleCase(value) {
  if (!isString(value)) return "Card";
  return value
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ") || "Card";
}

function cardLabel(paymentMethod) {
  const last4 = paymentMethod?.card?.last4;
  if (typeof last4 !== "string" || !/^\d{4}$/.test(last4)) return null;
  return `${titleCase(paymentMethod.card.brand)} •••• ${last4}`;
}

function normalizeAppOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Stripe test setup needs a local app URL.");
  }
  if (
    url.protocol !== "http:"
    || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || (url.pathname !== "" && url.pathname !== "/")
    || url.search
    || url.hash
  ) {
    throw new Error("Stripe test setup needs a local app URL.");
  }
  return url.origin;
}

function cleanState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Could not read saved Stripe payment setup.");
  }
  const customerId = value.customerId === null || value.customerId === undefined
    ? null
    : value.customerId;
  const paymentMethodId = value.paymentMethodId === null || value.paymentMethodId === undefined
    ? null
    : value.paymentMethodId;
  const card = value.cardLabel === null || value.cardLabel === undefined ? null : value.cardLabel;
  if (customerId !== null && !hasPrefix(customerId, "cus_")) {
    throw new Error("Could not read saved Stripe payment setup.");
  }
  if (paymentMethodId !== null && !hasPrefix(paymentMethodId, "pm_")) {
    throw new Error("Could not read saved Stripe payment setup.");
  }
  if (card !== null && (typeof card !== "string" || card.length > 80)) {
    throw new Error("Could not read saved Stripe payment setup.");
  }

  let pendingSetup = null;
  if (value.pendingSetup !== null && value.pendingSetup !== undefined) {
    const pending = value.pendingSetup;
    if (
      !pending
      || typeof pending !== "object"
      || !hasPrefix(pending.sessionId, "cs_test_")
      || !hasPrefix(pending.customerId, "cus_")
    ) {
      throw new Error("Could not read saved Stripe payment setup.");
    }
    pendingSetup = { sessionId: pending.sessionId, customerId: pending.customerId };
  }

  return {
    version: 1,
    customerId,
    paymentMethodId,
    cardLabel: paymentMethodId ? card || "Saved test card" : null,
    pendingSetup,
  };
}

class StripeApiError extends Error {
  constructor({ status = null, code = null, declineCode = null, intentStatus = null, kind = "request" } = {}) {
    super("Stripe request failed.");
    this.status = status;
    this.code = code;
    this.declineCode = declineCode;
    this.intentStatus = intentStatus;
    this.kind = kind;
  }
}

function apiErrorFromResponse(status, payload) {
  const error = payload && typeof payload.error === "object" ? payload.error : {};
  const paymentIntent = error.payment_intent;
  return new StripeApiError({
    status,
    code: isString(error.code) ? error.code : null,
    declineCode: isString(error.decline_code) ? error.decline_code : null,
    intentStatus: typeof paymentIntent === "object" && isString(paymentIntent.status)
      ? paymentIntent.status
      : null,
    kind: "http",
  });
}

function setupFailureMessage(error) {
  if (error instanceof StripeApiError && (error.status === 401 || error.status === 403)) {
    return "Stripe test mode needs a valid test key.";
  }
  if (error instanceof StripeApiError && error.status === 429) {
    return "Stripe test mode is busy. Try connecting the test card again shortly.";
  }
  return "Could not start Stripe test-card setup. Please try again.";
}

function setupVerificationMessage(error) {
  if (error instanceof StripeApiError && (error.status === 401 || error.status === 403)) {
    return "Stripe test mode needs a valid test key.";
  }
  if (error instanceof StripeApiError && error.status === 429) {
    return "Stripe test mode is busy. Try verifying the test card again shortly.";
  }
  return "Could not verify that test card. Return to setup and try again.";
}

function chargeFailureMessage(error) {
  if (error instanceof StripeApiError) {
    if (error.code === "authentication_required" || error.intentStatus === "requires_action") {
      return "Your saved test card needs authentication. Connect a different test card.";
    }
    if (error.code === "card_declined" || error.declineCode) {
      return "Your saved test card was declined. Connect a different test card.";
    }
    if (error.status === 401 || error.status === 403) {
      return "Stripe test mode needs a valid test key.";
    }
    if (error.status === 429) {
      return "Stripe test mode is busy. Retry this penalty shortly.";
    }
    if (error.status === 402) {
      return "Stripe could not charge the saved test card. Connect a different test card or try again.";
    }
  }
  return "Stripe could not confirm this test penalty. It was not marked as successful.";
}

function chargeStatusMessage(paymentIntent) {
  switch (paymentIntent?.status) {
    case "requires_action":
      return "Your saved test card needs authentication. Connect a different test card.";
    case "requires_payment_method":
    case "canceled":
      return "Your saved test card could not be charged. Connect a different test card.";
    case "processing":
      return "The test charge is still processing and was not marked as successful.";
    default:
      return "Stripe could not confirm this test penalty. It was not marked as successful.";
  }
}

function paymentSnapshotFromState(state) {
  if (!hasPrefix(state?.customerId, "cus_") || !hasPrefix(state?.paymentMethodId, "pm_")) return null;
  return { customerId: state.customerId, paymentMethodId: state.paymentMethodId };
}

function isPaymentSnapshot(value) {
  return Boolean(value)
    && typeof value === "object"
    && hasPrefix(value.customerId, "cus_")
    && hasPrefix(value.paymentMethodId, "pm_");
}

function pendingCharge(paymentId = null) {
  return {
    status: "pending",
    ...(hasPrefix(paymentId, "pi_") ? { paymentId } : {}),
    message: "The test charge is still being confirmed and was not marked as successful.",
  };
}

function isAmbiguousChargeError(error) {
  if (!(error instanceof StripeApiError)) return true;
  return error.kind === "network"
    || error.kind === "timeout"
    || error.kind === "response"
    || error.status === 429
    || error.status === 409
    || error.code === "idempotency_key_in_use"
    || (Number.isInteger(error.status) && error.status >= 500);
}

function unknownPendingIsTooOld(reservedAt, now = Date.now()) {
  if (!isString(reservedAt)) return false;
  const reservedMs = Date.parse(reservedAt);
  return Number.isFinite(reservedMs) && now - reservedMs >= UNKNOWN_PAYMENT_RETENTION_MS;
}

export class StripePayments {
  #secretKey;
  #dataDirectory;
  #filePath;
  #appOrigin;
  #fetch;
  #state = null;
  #loadPromise = null;
  #queue = Promise.resolve();

  constructor({ secretKey, dataDirectory, appOrigin, fetchImpl = fetch } = {}) {
    this.#secretKey = typeof secretKey === "string" ? secretKey : "";
    this.#dataDirectory = dataDirectory;
    this.#filePath = typeof dataDirectory === "string" ? path.join(dataDirectory, "stripe-payments.json") : null;
    this.#appOrigin = appOrigin;
    this.#fetch = fetchImpl;
  }

  async status() {
    const state = await this.#load();
    return this.#statusFromState(state);
  }

  async createSetup() {
    this.#requireTestKey();
    const appOrigin = normalizeAppOrigin(this.#appOrigin);
    return this.#exclusive(async () => {
      const state = await this.#load();
      let customerId = state.customerId;

      if (!customerId) {
        let customer;
        try {
          customer = await this.#request("POST", "/customers", {
            form: new URLSearchParams({ "metadata[app]": "end_itt" }),
          });
        } catch (error) {
          throw new Error(setupFailureMessage(error));
        }
        if (!hasPrefix(customer?.id, "cus_") || customer.livemode !== false) {
          throw new Error("Could not start Stripe test-card setup. Please try again.");
        }
        state.customerId = customer.id;
        customerId = customer.id;
        await this.#write();
      }

      const form = new URLSearchParams();
      form.set("mode", "setup");
      form.set("customer", customerId);
      form.set("currency", "usd");
      form.append("allowed_payment_method_types[]", "card");
      form.set("success_url", `${appOrigin}/?stripe_setup_session={CHECKOUT_SESSION_ID}`);
      form.set("cancel_url", `${appOrigin}/?stripe_setup=cancelled`);

      let session;
      try {
        session = await this.#request("POST", "/checkout/sessions", { form });
      } catch (error) {
        throw new Error(setupFailureMessage(error));
      }
      if (
        !hasPrefix(session?.id, "cs_test_")
        || session.livemode !== false
        || !isString(session.url)
        || !session.url.startsWith("https://")
      ) {
        throw new Error("Could not start Stripe test-card setup. Please try again.");
      }

      state.pendingSetup = { sessionId: session.id, customerId };
      await this.#write();
      return { url: session.url };
    });
  }

  async completeSetup(sessionId) {
    if (!isTestKey(this.#secretKey)) return this.status();
    if (!hasPrefix(sessionId, "cs_test_")) {
      const state = await this.#load();
      return this.#statusFromState(state, "This test-card setup link is not recognized. Start a new setup.");
    }

    return this.#exclusive(async () => {
      const state = await this.#load();
      const pending = state.pendingSetup;
      if (!pending || pending.sessionId !== sessionId || pending.customerId !== state.customerId) {
        return this.#statusFromState(state, "This test-card setup link is not recognized. Start a new setup.");
      }

      let session;
      try {
        session = await this.#request("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`);
      } catch (error) {
        return this.#statusFromState(state, setupVerificationMessage(error));
      }
      const setupIntentId = idFrom(session?.setup_intent);
      if (
        session?.id !== pending.sessionId
        || session?.livemode !== false
        || session?.mode !== "setup"
        || session?.status !== "complete"
        || idFrom(session?.customer) !== state.customerId
        || !hasPrefix(setupIntentId, "seti_")
      ) {
        return this.#statusFromState(state, "This test-card setup has not completed yet. Return to Checkout and try again.");
      }

      let setupIntent;
      try {
        setupIntent = await this.#request("GET", `/setup_intents/${encodeURIComponent(setupIntentId)}`);
      } catch (error) {
        return this.#statusFromState(state, setupVerificationMessage(error));
      }
      const paymentMethodId = idFrom(setupIntent?.payment_method);
      if (
        setupIntent?.id !== setupIntentId
        || setupIntent?.livemode !== false
        || setupIntent?.status !== "succeeded"
        || setupIntent?.usage !== "off_session"
        || idFrom(setupIntent?.customer) !== state.customerId
        || !hasPrefix(paymentMethodId, "pm_")
      ) {
        return this.#statusFromState(state, "This test card is not ready for off-session charges. Try setup again.");
      }

      let paymentMethod;
      try {
        paymentMethod = await this.#request("GET", `/payment_methods/${encodeURIComponent(paymentMethodId)}`);
      } catch (error) {
        return this.#statusFromState(state, setupVerificationMessage(error));
      }
      const savedCardLabel = cardLabel(paymentMethod);
      if (
        paymentMethod?.id !== paymentMethodId
        || paymentMethod?.livemode !== false
        || paymentMethod?.type !== "card"
        || idFrom(paymentMethod?.customer) !== state.customerId
        || !savedCardLabel
      ) {
        return this.#statusFromState(state, "This test card could not be verified. Try setup again.");
      }

      state.paymentMethodId = paymentMethodId;
      state.cardLabel = savedCardLabel;
      state.pendingSetup = null;
      await this.#write();
      return this.#statusFromState(state);
    });
  }

  async prepareCharge() {
    if (!isTestKey(this.#secretKey)) {
      return {
        status: "demo",
        message: "No Stripe test key is configured, so no money was charged.",
      };
    }
    const state = await this.#load();
    const paymentSnapshot = paymentSnapshotFromState(state);
    if (!paymentSnapshot) {
      return {
        status: "not_connected",
        message: "Connect a test card before using Stripe test charges.",
      };
    }
    return { status: "ready", paymentSnapshot };
  }

  async charge({ amountDollars, idempotencyKey, paymentSnapshot = null, paymentId = null, reservedAt = null } = {}) {
    if (!Number.isInteger(amountDollars) || !ALLOWED_AMOUNTS.has(amountDollars)) {
      return {
        status: "failed",
        message: "Test penalties must be exactly $1, $5, or $10.",
      };
    }
    if (!isIdempotencyKey(idempotencyKey)) {
      return {
        status: "failed",
        message: "This penalty could not be safely identified for retrying.",
      };
    }
    if (!isTestKey(this.#secretKey)) {
      if (hasPrefix(paymentId, "pi_") || isPaymentSnapshot(paymentSnapshot)) return pendingCharge(paymentId);
      return this.prepareCharge();
    }

    if (paymentId !== null && paymentId !== undefined) {
      if (!hasPrefix(paymentId, "pi_")) {
        return {
          status: "failed",
          message: "This penalty could not be safely identified for retrying.",
        };
      }
      return this.#retrieveCharge(paymentId);
    }

    let snapshot = paymentSnapshot;
    if (snapshot !== null && snapshot !== undefined && !isPaymentSnapshot(snapshot)) {
      return {
        status: "failed",
        message: "This penalty could not be safely identified for retrying.",
      };
    }
    if (!snapshot) {
      const prepared = await this.prepareCharge();
      if (prepared.status !== "ready") return prepared;
      snapshot = prepared.paymentSnapshot;
    }
    if (unknownPendingIsTooOld(reservedAt)) return pendingCharge();

    const form = new URLSearchParams();
    form.set("amount", String(amountDollars * 100));
    form.set("currency", "usd");
    form.set("customer", snapshot.customerId);
    form.set("payment_method", snapshot.paymentMethodId);
    form.set("confirm", "true");
    form.set("off_session", "true");
    form.set("error_on_requires_action", "true");
    form.append("allowed_payment_method_types[]", "card");
    form.set("metadata[app]", "end_itt");

    let paymentIntent;
    try {
      paymentIntent = await this.#request("POST", "/payment_intents", { form, idempotencyKey });
    } catch (error) {
      if (isAmbiguousChargeError(error)) return pendingCharge();
      return { status: "failed", message: chargeFailureMessage(error) };
    }
    return this.#chargeOutcome(paymentIntent);
  }

  async #retrieveCharge(paymentId) {
    let paymentIntent;
    try {
      paymentIntent = await this.#request("GET", `/payment_intents/${encodeURIComponent(paymentId)}`);
    } catch (error) {
      return pendingCharge(paymentId);
    }
    return this.#chargeOutcome(paymentIntent, paymentId);
  }

  #chargeOutcome(paymentIntent, expectedPaymentId = null) {
    const paymentId = hasPrefix(paymentIntent?.id, "pi_") ? paymentIntent.id : null;
    if (paymentIntent?.livemode !== false || !paymentId || (expectedPaymentId && paymentId !== expectedPaymentId)) {
      return pendingCharge(expectedPaymentId || paymentId);
    }
    if (paymentIntent.status === "succeeded") return { status: "succeeded", paymentId };
    if (paymentIntent.status === "processing" || paymentIntent.status === "requires_confirmation" || paymentIntent.status === "requires_capture") {
      return pendingCharge(paymentId);
    }
    if (paymentIntent.status === "requires_action" || paymentIntent.status === "requires_payment_method" || paymentIntent.status === "canceled") {
      return { status: "failed", paymentId, message: chargeStatusMessage(paymentIntent) };
    }
    return pendingCharge(paymentId);
  }

  #requireTestKey() {
    if (!isTestKey(this.#secretKey)) {
      throw new Error("Stripe test setup needs an sk_test_ or rk_test_ key.");
    }
  }

  #statusFromState(state, message = undefined) {
    if (!isTestKey(this.#secretKey)) {
      return {
        mode: "demo",
        connected: false,
        cardLabel: null,
        message: this.#secretKey
          ? "Stripe is disabled until a test key is configured."
          : "Add a Stripe test key to connect a test card.",
      };
    }
    const connected = hasPrefix(state.customerId, "cus_") && hasPrefix(state.paymentMethodId, "pm_");
    const status = {
      mode: "test",
      connected,
      cardLabel: connected ? state.cardLabel || "Saved test card" : null,
    };
    if (message !== undefined) status.message = message;
    return status;
  }

  async #load() {
    if (this.#state) return this.#state;
    if (!this.#loadPromise) {
      this.#loadPromise = this.#loadInitialState().finally(() => {
        this.#loadPromise = null;
      });
    }
    return this.#loadPromise;
  }

  async #loadInitialState() {
    if (!this.#dataDirectory || !this.#filePath) {
      throw new Error("Stripe payment storage is not configured.");
    }
    await mkdir(this.#dataDirectory, { recursive: true });
    try {
      this.#state = cleanState(JSON.parse(await readFile(this.#filePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.#state = clone(EMPTY_STATE);
      } else {
        throw new Error("Could not read saved Stripe payment setup.");
      }
    }
    return this.#state;
  }

  async #write() {
    const temporaryPath = `${this.#filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.#state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.#filePath);
  }

  #exclusive(operation) {
    const run = this.#queue.then(operation);
    this.#queue = run.catch(() => {});
    return run;
  }

  async #request(method, pathname, { form = null, idempotencyKey = null } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const headers = {
      Authorization: `Bearer ${this.#secretKey}`,
      "Stripe-Version": STRIPE_VERSION,
    };
    if (form) headers["Content-Type"] = "application/x-www-form-urlencoded";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    let response;
    try {
      response = await this.#fetch(`${API_BASE}${pathname}`, {
        method,
        headers,
        body: form ? form.toString() : undefined,
        signal: controller.signal,
      });
      if (!response || typeof response.ok !== "boolean" || typeof response.text !== "function") {
        throw new StripeApiError({ kind: "response" });
      }
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new StripeApiError({ status: response.status, kind: "response" });
      }
      if (!response.ok) throw apiErrorFromResponse(response.status, payload);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new StripeApiError({ status: response.status, kind: "response" });
      }
      return payload;
    } catch (error) {
      if (error instanceof StripeApiError) throw error;
      if (controller.signal.aborted || error?.name === "AbortError") {
        throw new StripeApiError({ kind: "timeout" });
      }
      throw new StripeApiError({
        status: Number.isInteger(response?.status) ? response.status : null,
        kind: response ? "response" : "network",
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
