import sgMail from "@sendgrid/mail";
import fs from "fs";
import path from "path";

sgMail.setApiKey(`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`);

export const sendVerificationEmail = async (to, name, token) => {
// Load the HTML template
    const templatePath = path.join(process.cwd(), "src", "emailTemplates", "verifyEmail.html");
    let htmlContent = fs.readFileSync(templatePath, "utf8");

    // Replace placeholders
    htmlContent = htmlContent
      .replace(/{{name}}/g, name)
      .replace(/{{verificationLink}}/g, `${process.env.CLIENT_URL}/verify?token=${token}`);


  const msg = {
    to,
    from: `no-reply@devcamp.com.ng`, // Must be verified in SendGrid if using a free plan
    subject: "Verify your Velte Account",
    html: htmlContent
  };

  await sgMail.send(msg);
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
