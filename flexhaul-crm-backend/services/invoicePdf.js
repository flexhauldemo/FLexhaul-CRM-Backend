// services/invoicePdf.js
//
// Generates a clean, itemized invoice PDF using pdfkit — a pure-JS
// library, no native compilation, safe on any host. Returns a Buffer
// that the route handler streams straight to the browser as a download.

const PDFDocument = require("pdfkit");

const INK = "#1c1812";
const RUST = "#c9590d";
const STEEL = "#6f6a5e";

function money(n) {
  return "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return "\u2014";
  try {
    return new Date(d + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch (e) {
    return d;
  }
}

// invoice: the invoice row, with customer/job fields already joined on
// (customer_name, customer_phone, customer_email, job_address).
function buildInvoicePdf(invoice) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ---- Header ----
    doc.fontSize(22).fillColor(INK).font("Helvetica-Bold").text("FlexHaul & Demolition LLC", 50, 50);
    doc.fontSize(10).fillColor(STEEL).font("Helvetica").text("Lafayette, IN & surrounding communities", 50, 76);
    doc.text("(765) 885-6317  \u00b7  Info.flexhaul@gmail.com", 50, 90);

    doc.fontSize(20).fillColor(RUST).font("Helvetica-Bold").text("INVOICE", 400, 50, { align: "right" });
    doc.fontSize(10).fillColor(STEEL).font("Helvetica").text(`Invoice #FH-${String(invoice.id).padStart(4, "0")}`, 400, 76, { align: "right" });
    doc.text(`Date: ${fmtDate(invoice.created_at ? invoice.created_at.slice(0, 10) : null)}`, 400, 90, { align: "right" });
    doc.text(`Due: ${fmtDate(invoice.due_date)}`, 400, 104, { align: "right" });

    doc.moveTo(50, 130).lineTo(562, 130).strokeColor("#d8d0b8").stroke();

    // ---- Bill to / Job ----
    doc.fontSize(9).fillColor(STEEL).font("Helvetica-Bold").text("BILL TO", 50, 145);
    doc.fontSize(11).fillColor(INK).font("Helvetica").text(invoice.customer_name || "", 50, 160);
    if (invoice.customer_phone) doc.text(invoice.customer_phone, 50, 175);
    if (invoice.customer_email) doc.text(invoice.customer_email, 50, 190);

    doc.fontSize(9).fillColor(STEEL).font("Helvetica-Bold").text("SERVICE ADDRESS", 320, 145);
    doc.fontSize(11).fillColor(INK).font("Helvetica").text(invoice.job_address || "\u2014", 320, 160, { width: 240 });

    // ---- Status badge ----
    const statusColor = invoice.status === "paid" ? "#4b7d4a" : invoice.status === "overdue" ? RUST : STEEL;
    doc.fontSize(10).fillColor(statusColor).font("Helvetica-Bold").text(invoice.status.toUpperCase(), 50, 215);

    // ---- Line items table ----
    let y = 245;
    doc.fontSize(9).fillColor(STEEL).font("Helvetica-Bold");
    doc.text("DESCRIPTION", 50, y);
    doc.text("QTY", 340, y, { width: 50, align: "right" });
    doc.text("RATE", 400, y, { width: 70, align: "right" });
    doc.text("AMOUNT", 480, y, { width: 82, align: "right" });
    y += 15;
    doc.moveTo(50, y).lineTo(562, y).strokeColor("#d8d0b8").stroke();
    y += 10;

    let lineItems = [];
    try {
      lineItems = JSON.parse(invoice.line_items || "[]");
    } catch (e) {
      lineItems = [];
    }

    doc.font("Helvetica").fontSize(10).fillColor(INK);
    if (lineItems.length === 0) {
      doc.text("Service rendered", 50, y);
      doc.text(money(invoice.amount), 480, y, { width: 82, align: "right" });
      y += 20;
    } else {
      lineItems.forEach((item) => {
        doc.text(item.label || "", 50, y, { width: 280 });
        doc.text(String(item.qty ?? ""), 340, y, { width: 50, align: "right" });
        doc.text(item.rate !== undefined ? money(item.rate) : "", 400, y, { width: 70, align: "right" });
        doc.text(money(item.amount), 480, y, { width: 82, align: "right" });
        y += 20;
      });
    }

    y += 6;
    doc.moveTo(50, y).lineTo(562, y).strokeColor("#d8d0b8").stroke();
    y += 14;

    doc.fontSize(12).font("Helvetica-Bold").fillColor(INK).text("TOTAL", 400, y, { width: 70, align: "right" });
    doc.fillColor(RUST).text(money(invoice.amount), 480, y, { width: 82, align: "right" });

    // ---- Footer ----
    doc.fontSize(9).fillColor(STEEL).font("Helvetica").text(
      "Thank you for choosing FlexHaul & Demolition. Questions about this invoice? Call or text (765) 885-6317.",
      50,
      720,
      { width: 512, align: "center" }
    );

    doc.end();
  });
}

module.exports = { buildInvoicePdf };
