// services/stripePayments.js
//
// Generates a real Stripe Checkout payment link for an invoice, so a
// customer can pay by card without you having to take their card number
// over the phone. Entirely optional — if STRIPE_SECRET_KEY isn't set,
// every function here just returns null and the rest of the app carries
// on exactly as it did before (invoice still shows, still downloadable
// as a PDF, just without a "Pay Now" button).
//
// ENVIRONMENT VARIABLES REQUIRED TO ACTIVATE THIS:
//   STRIPE_SECRET_KEY   - from your Stripe Dashboard > Developers > API keys.
//                         Starts with sk_test_... while testing, sk_live_...
//                         once you're ready to take real payments.
//   PUBLIC_SITE_URL     - your live site's URL, e.g. https://flexhaul.netlify.app
//                         Used to build the "back to site" redirect after payment.

let stripeClient = null;
let attempted = false;

function getClient() {
  if (attempted) return stripeClient;
  attempted = true;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  try {
    const Stripe = require("stripe");
    stripeClient = new Stripe(key);
    return stripeClient;
  } catch (err) {
    console.error("Stripe misconfigured — check STRIPE_SECRET_KEY:", err.message);
    return null;
  }
}

function isConfigured() {
  return !!getClient();
}

// invoice: the invoice row, with customer_name already joined on.
// Returns the Checkout URL, or null if Stripe isn't configured or the
// request fails for any reason (network hiccup, bad key, etc.) — never
// throws, since a payment link failing shouldn't break anything else.
async function createPaymentLink(invoice) {
  const client = getClient();
  if (!client) return null;

  const siteUrl = process.env.PUBLIC_SITE_URL || "https://flexhaul.netlify.app";

  try {
    const session = await client.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: Math.round(Number(invoice.amount) * 100),
            product_data: {
              name: `FlexHaul & Demolition \u2014 Invoice #FH-${String(invoice.id).padStart(4, "0")}`,
              description: invoice.customer_name ? `Billed to ${invoice.customer_name}` : undefined,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${siteUrl}/invoice.html?token=${invoice.share_token}&paid=1`,
      cancel_url: `${siteUrl}/invoice.html?token=${invoice.share_token}`,
      metadata: { invoice_id: String(invoice.id) },
    });
    return { url: session.url, sessionId: session.id };
  } catch (err) {
    console.error(`Stripe payment link creation failed for invoice #${invoice.id}:`, err.message);
    return null;
  }
}

module.exports = { isConfigured, createPaymentLink };
