import sgMail from "@sendgrid/mail";
import dotenv from 'dotenv-flow';

dotenv.config();

import fs from "fs";
import path from "path";


sgMail.setApiKey(process.env.SENDGRID_API_KEY);

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
    await sgMail.send(msg);
    console.log(`✅ Verification email sent to ${to}`);
  } catch (error) {
    console.error("❌ Error sending verification email:", error);
    throw new Error("Failed to send verification email");
  }
};

// import { Resend } from "resend";
// const resend = new Resend(`re_YPkbha3v_9h5c266cSxJP7QCEz3JZwWjS`);

// export const sendVerificationEmail = async (to, name, token) => {
//   const verificationUrl = `${process.env.CLIENT_URL}/verify?token=${token}`;

//   await resend.emails.send({
//     from: "Velte <no-reply@velte.ng>",
//     to: [to],
//     subject: "Verify your Velte account",
//     html: `
//         <h2>Welcome to Velte, ${name}!</h2>
//       <p>Click the button below to verify your account:</p>
//       <a href="${verificationUrl}" 
//          style="display:inline-block;padding:10px 20px;background:#4F46E5;color:white;text-decoration:none;border-radius:8px;">
//          Verify Account
//       </a>
//     `,
//   });
// };
