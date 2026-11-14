import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { StripePayments } from "../lib/payments.mjs";

const TEST_KEY = "sk_test_payment_module";
const ORIGIN = "http://127.0.0.1:4312";

async function withDirectory(run) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "end-itt-payments-test-"));
  try {
    return await run(dataDirectory);
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestData(options) {
  return new URLSearchParams(options.body || "");
}

test("demo and invalid keys never call Stripe or report a connected card", async () => {
  await withDirectory(async (dataDirectory) => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      throw new Error("must not call Stripe");
    };
    const demo = new StripePayments({ dataDirectory, appOrigin: ORIGIN, fetchImpl });
    assert.deepEqual(await demo.status(), {
      mode: "demo",
      connected: false,
      cardLabel: null,
      message: "Add a Stripe test key to connect a test card.",
    });
    assert.deepEqual(await demo.charge({ amountDollars: 5, idempotencyKey: "episode-1" }), {
      status: "demo",
      message: "No Stripe test key is configured, so no money was charged.",
    });

    const live = new StripePayments({
      secretKey: "sk_live_not_allowed",
      dataDirectory,
      appOrigin: ORIGIN,
      fetchImpl,
    });
    const status = await live.status();
    assert.equal(status.mode, "demo");
    assert.equal(status.connected, false);
    assert.match(status.message, /disabled.*test key/i);
    await assert.rejects(live.createSetup(), /sk_test_ or rk_test_/);
    assert.equal(calls, 0);
  });
});

test("setup creates a test Customer then a hosted setup Checkout Session with fixed callback URLs", async () => {
  await withDirectory(async (dataDirectory) => {
    const calls = [];
    const payments = new StripePayments({
      secretKey: TEST_KEY,
      dataDirectory,
      appOrigin: ORIGIN,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/customers")) return json({ id: "cus_enditt", livemode: false });
        if (url.endsWith("/checkout/sessions")) {
          return json({
            id: "cs_test_enditt_setup",
            livemode: false,
            url: "https://checkout.stripe.com/c/pay/cs_test_enditt_setup",
          });
        }
        assert.fail(`Unexpected Stripe URL: ${url}`);
      },
    });

    assert.deepEqual(await payments.createSetup(), {
      url: "https://checkout.stripe.com/c/pay/cs_test_enditt_setup",
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.method, "POST");
    assert.equal(calls[0].options.headers["Stripe-Version"], "2026-10-28.endive");
    assert.equal(requestData(calls[0].options).get("metadata[app]"), "end_itt");

    const checkout = requestData(calls[1].options);
    assert.equal(calls[1].options.headers["Stripe-Version"], "2026-10-28.endive");
    assert.equal(checkout.get("mode"), "setup");
    assert.equal(checkout.get("customer"), "cus_enditt");
    assert.equal(checkout.get("currency"), "usd");
    assert.equal(checkout.get("allowed_payment_method_types[]"), "card");
    assert.equal(checkout.has("setup_intent_data[usage]"), false);
    assert.equal(checkout.get("success_url"), `${ORIGIN}/?stripe_setup_session={CHECKOUT_SESSION_ID}`);
    assert.equal(checkout.get("cancel_url"), `${ORIGIN}/?stripe_setup=cancelled`);

    const persisted = await readFile(path.join(dataDirectory, "stripe-payments.json"), "utf8");
    assert.match(persisted, /cs_test_enditt_setup/);
    assert.equal(persisted.includes(TEST_KEY), false);
  });
});

test("setup completion only accepts the locally created completed test session and persists its card", async () => {
  await withDirectory(async (dataDirectory) => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/customers")) return json({ id: "cus_enditt", livemode: false });
      if (url.endsWith("/checkout/sessions")) {
        return json({
          id: "cs_test_enditt_setup",
          livemode: false,
          url: "https://checkout.stripe.com/c/pay/cs_test_enditt_setup",
        });
      }
      if (url.endsWith("/checkout/sessions/cs_test_enditt_setup")) {
        return json({
          id: "cs_test_enditt_setup",
          livemode: false,
          mode: "setup",
          status: "complete",
          customer: "cus_enditt",
          setup_intent: "seti_enditt",
        });
      }
      if (url.endsWith("/setup_intents/seti_enditt")) {
        return json({
          id: "seti_enditt",
          livemode: false,
          customer: "cus_enditt",
          status: "succeeded",
          usage: "off_session",
          payment_method: "pm_enditt",
        });
      }
      if (url.endsWith("/payment_methods/pm_enditt")) {
        return json({
          id: "pm_enditt",
          livemode: false,
          customer: "cus_enditt",
          type: "card",
          card: { brand: "visa", last4: "4242" },
        });
      }
      assert.fail(`Unexpected Stripe URL: ${url}`);
    };
    const payments = new StripePayments({ secretKey: TEST_KEY, dataDirectory, appOrigin: ORIGIN, fetchImpl });
    await payments.createSetup();

    const unknown = await payments.completeSetup("cs_test_other_session");
    assert.equal(unknown.connected, false);
    assert.match(unknown.message, /not recognized/i);
    assert.equal(calls.length, 2, "a foreign session must not be retrieved");

    assert.deepEqual(await payments.completeSetup("cs_test_enditt_setup"), {
      mode: "test",
      connected: true,
      cardLabel: "Visa •••• 4242",
    });
    assert.equal(calls.length, 5);

    const reloaded = new StripePayments({ secretKey: TEST_KEY, dataDirectory, appOrigin: ORIGIN, fetchImpl });
    assert.deepEqual(await reloaded.status(), {
      mode: "test",
      connected: true,
      cardLabel: "Visa •••• 4242",
    });
  });
});

test("completion refuses a mismatched Customer before it can save a payment method", async () => {
  await withDirectory(async (dataDirectory) => {
    const calls = [];
    const payments = new StripePayments({
      secretKey: TEST_KEY,
      dataDirectory,
      appOrigin: ORIGIN,
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        if (url.endsWith("/customers")) return json({ id: "cus_enditt", livemode: false });
        if (url.endsWith("/checkout/sessions")) {
          return json({ id: "cs_test_enditt_setup", livemode: false, url: "https://checkout.stripe.com/c/pay/example" });
        }
        if (url.endsWith("/checkout/sessions/cs_test_enditt_setup")) {
          return json({
            id: "cs_test_enditt_setup",
            livemode: false,
            mode: "setup",
            status: "complete",
            customer: "cus_someone_else",
            setup_intent: "seti_enditt",
          });
        }
        assert.fail(`Unexpected Stripe URL: ${url}`);
      },
    });
    await payments.createSetup();
    const result = await payments.completeSetup("cs_test_enditt_setup");
    assert.equal(result.connected, false);
    assert.match(result.message, /not completed yet/i);
    assert.equal(calls.length, 3);
  });
});

test("off-session charges use capped cents, test-only confirmation, and the supplied idempotency key", async () => {
  await withDirectory(async (dataDirectory) => {
    let paymentRequest;
    let stage = "setup";
    const payments = new StripePayments({
      secretKey: TEST_KEY,
      dataDirectory,
      appOrigin: ORIGIN,
      fetchImpl: async (url, options) => {
        if (stage === "charge") {
          paymentRequest = { url, options };
          return json({ id: "pi_enditt_penalty", livemode: false, status: "succeeded" });
        }
        if (url.endsWith("/customers")) return json({ id: "cus_enditt", livemode: false });
        if (url.endsWith("/checkout/sessions")) {
          return json({ id: "cs_test_enditt_setup", livemode: false, url: "https://checkout.stripe.com/c/pay/example" });
        }
        if (url.endsWith("/checkout/sessions/cs_test_enditt_setup")) {
          return json({ id: "cs_test_enditt_setup", livemode: false, mode: "setup", status: "complete", customer: "cus_enditt", setup_intent: "seti_enditt" });
        }
        if (url.endsWith("/setup_intents/seti_enditt")) {
          return json({ id: "seti_enditt", livemode: false, customer: "cus_enditt", status: "succeeded", usage: "off_session", payment_method: "pm_enditt" });
        }
        if (url.endsWith("/payment_methods/pm_enditt")) {
          return json({ id: "pm_enditt", livemode: false, customer: "cus_enditt", type: "card", card: { brand: "visa", last4: "4242" } });
        }
        assert.fail(`Unexpected Stripe URL: ${url}`);
      },
    });
    await payments.createSetup();
    await payments.completeSetup("cs_test_enditt_setup");
    stage = "charge";

    assert.deepEqual(await payments.charge({ amountDollars: 5, idempotencyKey: "episode-123" }), {
      status: "succeeded",
      paymentId: "pi_enditt_penalty",
    });
    assert.equal(paymentRequest.url, "https://api.stripe.com/v1/payment_intents");
    assert.equal(paymentRequest.options.headers["Stripe-Version"], "2026-10-28.endive");
    assert.equal(paymentRequest.options.headers["Idempotency-Key"], "episode-123");
    const form = requestData(paymentRequest.options);
    assert.equal(form.get("amount"), "500");
    assert.equal(form.get("currency"), "usd");
    assert.equal(form.get("customer"), "cus_enditt");
    assert.equal(form.get("payment_method"), "pm_enditt");
    assert.equal(form.get("confirm"), "true");
    assert.equal(form.get("off_session"), "true");
    assert.equal(form.get("error_on_requires_action"), "true");
    assert.equal(form.get("allowed_payment_method_types[]"), "card");
  });
});

test("charge never calls Stripe for invalid input or a missing card and never marks authentication or pending outcomes successful", async () => {
  await withDirectory(async (dataDirectory) => {
    let calls = 0;
    const disconnected = new StripePayments({
      secretKey: TEST_KEY,
      dataDirectory,
      appOrigin: ORIGIN,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not call Stripe");
      },
    });
    assert.equal((await disconnected.charge({ amountDollars: 7, idempotencyKey: "episode-1" })).status, "failed");
    assert.equal((await disconnected.charge({ amountDollars: 5, idempotencyKey: "" })).status, "failed");
    assert.equal((await disconnected.charge({ amountDollars: 5, idempotencyKey: "episode-1" })).status, "not_connected");
    assert.equal(calls, 0);

    const configuredDirectory = await mkdtemp(path.join(os.tmpdir(), "end-itt-payments-state-"));
    try {
      const state = {
        version: 1,
        customerId: "cus_enditt",
        paymentMethodId: "pm_enditt",
        cardLabel: "Visa •••• 4242",
        pendingSetup: null,
      };
      await (await import("node:fs/promises")).writeFile(
        path.join(configuredDirectory, "stripe-payments.json"),
        JSON.stringify(state),
        "utf8",
      );
      const authRequired = new StripePayments({
        secretKey: TEST_KEY,
        dataDirectory: configuredDirectory,
        appOrigin: ORIGIN,
        fetchImpl: async () => json({
          error: {
            code: "authentication_required",
            payment_intent: { status: "requires_action" },
          },
        }, 402),
      });
      const failed = await authRequired.charge({ amountDollars: 1, idempotencyKey: "episode-auth" });
      assert.equal(failed.status, "failed");
      assert.match(failed.message, /needs authentication/i);

      const processing = new StripePayments({
        secretKey: TEST_KEY,
        dataDirectory: configuredDirectory,
        appOrigin: ORIGIN,
        fetchImpl: async () => json({ id: "pi_processing", livemode: false, status: "processing" }),
      });
      const pending = await processing.charge({ amountDollars: 1, idempotencyKey: "episode-processing" });
      assert.equal(pending.status, "failed");
      assert.match(pending.message, /still processing/i);
    } finally {
      await rm(configuredDirectory, { recursive: true, force: true });
    }
  });
});

test("setup keeps its timeout active while Stripe response content is still being read", { concurrency: false }, async () => {
  await withDirectory(async (dataDirectory) => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timer = {};
    let timeoutCallback;
    let timerCleared = false;
    let startReadingBody;
    const bodyReading = new Promise((resolve) => {
      startReadingBody = resolve;
    });

    try {
      globalThis.setTimeout = (callback, milliseconds) => {
        assert.equal(milliseconds, 10_000);
        timeoutCallback = callback;
        return timer;
      };
      globalThis.clearTimeout = (handle) => {
        if (handle === timer) timerCleared = true;
      };

      const payments = new StripePayments({
        secretKey: TEST_KEY,
        dataDirectory,
        appOrigin: ORIGIN,
        fetchImpl: async (_url, options) => ({
          ok: true,
          status: 200,
          text() {
            startReadingBody();
            return new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => {
                const error = new Error("The response body timed out.");
                error.name = "AbortError";
                reject(error);
              }, { once: true });
            });
          },
        }),
      });

      const starting = payments.createSetup();
      await bodyReading;
      assert.equal(timerCleared, false, "the timeout must cover response.text()");
      timeoutCallback();
      await assert.rejects(starting, /Could not start Stripe test-card setup/i);
      assert.equal(timerCleared, true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
