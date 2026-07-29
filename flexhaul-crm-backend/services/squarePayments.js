// services/squarePayments.js
//
// Generates a real Square Checkout payment link for an invoice — the
// Square equivalent of services/stripePayments.js, same optional
// pattern: if it isn't configured, every function here just returns
// null and nothing else in the app changes or breaks.
//
// You only need ONE of Square or Stripe configured, not both. If both
// happen to be set, routes/publicShare.js tries Square first, since
// that's what most contractors already have a merchant account with
// for taking payments in person.
//
// ENVIRONMENT VARIABLES REQUIRED TO ACTIVATE THIS:
//   SQUARE_ACCESS_TOKEN   - from your Square Developer Dashboard (see
//                           README.md "Connect Square" for exactly where)
//   SQUARE_LOCATION_ID    - which of your Square locations the payment
//                           should post to — also in that same dashboard
//   SQUARE_ENVIRONMENT    - "sandbox" while testing, "production" once
//                           you're ready for real charges. Defaults to
//                           "production" if not set, since that's the
//                           one real businesses actually want.
//   PUBLIC_SITE_URL       - your live site's URL, e.g. https://flexhaul.netlify.app

const { SquareClient, SquareEnvironment } = require("square");

let squareClient = null;
let attempted = false;

function getClient() {
  if (attempted) return squareClient;
  attempted = true;
  const token = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;
  if (!token || !locationId) return null;
  try {
    squareClient = new SquareClient({
      token,
      environment:
        process.env.SQUARE_ENVIRONMENT === "sandbox" ? SquareEnvironment.Sandbox : SquareEnvironment.Production,
    });
    return squareClient;
  } catch (err) {
    console.error("Square misconfigured — check SQUARE_ACCESS_TOKEN:", err.message);
    return null;
  }
}

function isConfigured() {
  return !!getClient();
}

// invoice: the invoice row, with customer_name already joined on.
// Returns the Checkout URL, or null if Square isn't configured or the
// request fails for any reason — never throws.
async function createPaymentLink(invoice) {
  const client = getClient();
  if (!client) return null;

  const siteUrl = process.env.PUBLIC_SITE_URL || "https://flexhaul.netlify.app";
  const locationId = process.env.SQUARE_LOCATION_ID;

  try {
    const response = await client.checkout.paymentLinks.create({
      idempotencyKey: `invoice-${invoice.id}-${Date.now()}`,
      quickPay: {
        name: `FlexHaul & Demolition \u2014 Invoice #FH-${String(invoice.id).padStart(4, "0")}`,
        priceMoney: {
          amount: BigInt(Math.round(Number(invoice.amount) * 100)),
          currency: "USD",
        },
        locationId,
      },
      checkoutOptions: {
        redirectUrl: `${siteUrl}/invoice.html?token=${invoice.share_token}&paid=1`,
      },
    });
    const url = response.paymentLink && response.paymentLink.url;
    const id = response.paymentLink && response.paymentLink.id;
    if (!url) return null;
    return { url, sessionId: id };
  } catch (err) {
    console.error(`Square payment link creation failed for invoice #${invoice.id}:`, err.message);
    return null;
  }
}

module.exports = { isConfigured, createPaymentLink };
