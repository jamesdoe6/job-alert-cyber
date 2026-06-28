import nodemailer from "nodemailer";
import { config } from "dotenv";
config();

console.log("📧 Test envoi email...");
console.log("   SMTP_HOST :", process.env.SMTP_HOST);
console.log("   SMTP_USER :", process.env.SMTP_USER);
console.log("   EMAIL_TO  :", process.env.EMAIL_TO);

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: true, family: 4,
  family: 4,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

try {
  await transporter.verify();
  console.log("✅ Connexion SMTP OK");

  const info = await transporter.sendMail({
    from: `"Veille Emploi Cyber" <${process.env.EMAIL_FROM}>`,
    to: process.env.EMAIL_TO,
    subject: "[TEST] Veille Emploi Cyber — test de connexion",
    html: `<div style="font-family:Arial;padding:20px;background:#070e1a;color:#22d3ee;">
      <h2>✅ Email de test</h2>
      <p style="color:#94a3b8;">La configuration SMTP fonctionne correctement.<br>
      Tu recevras tes alertes emploi quotidiennes à cette adresse.</p>
      <p style="color:#475569;font-size:12px;">${new Date().toISOString()}</p>
    </div>`,
  });

  console.log("✅ Email envoyé :", info.messageId);
} catch (err) {
  console.error("❌ Erreur :", err.message);
}
