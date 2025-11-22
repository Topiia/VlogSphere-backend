const nodemailer = require("nodemailer");

const sendEmail = async ({ email, subject, message }) => {
  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST, // smtp.gmail.com
    port: process.env.EMAIL_PORT, // 465
    secure: true, // true for 465
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: `"VlogSphere" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: subject,
    html: message,
  });
};

module.exports = sendEmail;
