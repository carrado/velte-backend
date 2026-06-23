// import sgMail from "@sendgrid/mail";
import dotenv from 'dotenv-flow';
import { Resend } from "resend";
dotenv.config();

import fs from "fs";
import path from "path";


// sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

export const sendVerificationEmail = async (to, name, otp) => {
  try {
    // Load the updated HTML template
    const templatePath = path.join(
      process.cwd(),
      "src",
      "emailTemplates",
      "verifyEmail.html"
    );

    let htmlContent = fs.readFileSync(templatePath, "utf8");

    // Replace placeholders
    htmlContent = htmlContent
      .replace(/{{name}}/g, name)
      .replace(/{{otp}}/g, otp)
      .replace(/{{email}}/g, encodeURIComponent(to))
      .replace(/{{clientUrl}}/g, process.env.CLIENT_URL);

    // Build email message
    const msg = {
      to,
      from: "no-reply@devcamp.com.ng", // ✅ use verified sender in SendGrid
      subject: "Verify Your Velte Account",
      html: htmlContent,
    };

    // Send the email
    await resend.emails.send(msg);
    console.log(`✅ Verification email sent to ${to}`);
  } catch (error) {
    console.error("❌ Error sending verification email:", error);
    throw new Error("Failed to send verification email");
  }
};



export const sendPasswordChangeEmail = async (to, name, otp) => {
  try {
    const templatePath = path.join(
      process.cwd(),
      "src",
      "emailTemplates",
      "passwordChange.html"
    );

    let htmlContent = fs.readFileSync(templatePath, "utf8");

    htmlContent = htmlContent
      .replace(/{{name}}/g, name)
      .replace(/{{otp}}/g, otp);

    await resend.emails.send({
      to,
      from: "no-reply@devcamp.com.ng",
      subject: "Velte Password Change Verification",
      html: htmlContent,
    });

    console.log(`✅ Password change email sent to ${to}`);
  } catch (error) {
    console.error("❌ Error sending password change email:", error);
    throw new Error("Failed to send password change email");
  }
};


/**
 * Emails the customer the secret key for the public order-tracking page. Sent on
 * order creation. The matching tracking link is delivered separately to the
 * customer's WhatsApp (via staffly) — the customer needs both to view the order.
 *
 * Throws on failure; callers should fire-and-forget so a mail outage never blocks
 * order creation or the Paystack webhook.
 */
export const sendOrderTrackingEmail = async (to, name, key, orderRef) => {
  try {
    const templatePath = path.join(
      process.cwd(),
      "src",
      "emailTemplates",
      "orderTracking.html"
    );

    let htmlContent = fs.readFileSync(templatePath, "utf8");

    htmlContent = htmlContent
      .replace(/{{name}}/g, name || "there")
      .replace(/{{key}}/g, key)
      .replace(/{{orderRef}}/g, orderRef || "");

    await resend.emails.send({
      to,
      from: "no-reply@devcamp.com.ng",
      subject: "Your order tracking key",
      html: htmlContent,
    });

    console.log(`✅ Order tracking email sent to ${to}`);
  } catch (error) {
    console.error("❌ Error sending order tracking email:", error);
    throw new Error("Failed to send order tracking email");
  }
};


/**
 * Emails the customer their receipt after a successful payment. The rendered
 * receipt PDF is attached so the customer keeps a copy; a "View receipt" link to
 * the hosted PDF is also included as a fallback.
 *
 * Throws on failure; callers should fire-and-forget so a mail outage never blocks
 * the Paystack webhook (the order + payment are already recorded).
 */
export const sendReceiptEmail = async (
  to,
  name,
  { orderRef, receiptNumber, amount, receiptUrl, pdfBuffer } = {},
) => {
  try {
    const templatePath = path.join(
      process.cwd(),
      "src",
      "emailTemplates",
      "orderReceipt.html"
    );

    let htmlContent = fs.readFileSync(templatePath, "utf8");

    const amountText =
      typeof amount === "number" ? `₦${amount.toLocaleString()}` : amount || "";

    htmlContent = htmlContent
      .replace(/{{name}}/g, name || "there")
      .replace(/{{orderRef}}/g, orderRef || "")
      .replace(/{{receiptNumber}}/g, receiptNumber || "")
      .replace(/{{amount}}/g, amountText)
      .replace(/{{receiptUrl}}/g, receiptUrl || "#");

    const msg = {
      to,
      from: "no-reply@devcamp.com.ng",
      subject: `Your receipt${orderRef ? ` for order ${orderRef}` : ""}`,
      html: htmlContent,
    };

    // Attach the PDF when we have the rendered buffer; Resend accepts a Buffer
    // (or base64) as the attachment content.
    if (pdfBuffer) {
      msg.attachments = [
        {
          filename: `receipt-${receiptNumber || orderRef || "velte"}.pdf`,
          content: pdfBuffer,
        },
      ];
    }

    await resend.emails.send(msg);
    console.log(`✅ Receipt email sent to ${to}`);
  } catch (error) {
    console.error("❌ Error sending receipt email:", error);
    throw new Error("Failed to send receipt email");
  }
};


export const sendPasswordResetEmail = async (to, name, otp) => {
  try {
    // Load the updated HTML template
    const templatePath = path.join(
      process.cwd(),
      "src",
      "emailTemplates",
      "passwordReset.html"
    );

    let htmlContent = fs.readFileSync(templatePath, "utf8");

    // Replace placeholders
    htmlContent = htmlContent
      .replace(/{{name}}/g, name)
      .replace(/{{otp}}/g, otp)

    // Build email message
    const msg = {
      to,
      from: "no-reply@devcamp.com.ng", // ✅ use verified sender in SendGrid
      subject: "Password Reset",
      html: htmlContent,
    };

    // Send the email
    await resend.emails.send(msg);
    console.log(`✅ Password Reset email sent to ${to}`);
  } catch (error) {
    console.error("❌ Error sending password reset email:", error);
    throw new Error("Failed to send password reser email");
  }
};