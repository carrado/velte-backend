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