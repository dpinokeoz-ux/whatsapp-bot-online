require("dotenv").config();
const express = require("express");
const fs = require("fs");
const axios = require("axios");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------------------------------
// Users Storage
// ------------------------------
const usersFile = "users.json";
let users = fs.existsSync(usersFile)
  ? JSON.parse(fs.readFileSync(usersFile))
  : {};

function saveUsers() {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isExpired(purchaseDate) {
  if (!purchaseDate) return true;
  const purchase = new Date(purchaseDate);
  const now = new Date();
  const diffDays = (now - purchase) / (1000 * 60 * 60 * 24);
  return diffDays >= 7;
}

// ------------------------------
// Twilio Setup
// ------------------------------
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
const twilioNumber = process.env.TWILIO_WHATSAPP_NUMBER;
const adminNumber = process.env.ADMIN_NUMBER;

// ------------------------------
// AI SYSTEM (OpenAI → Grok fallback)
// ------------------------------
async function getAIResponse(message) {
  try {
    const openaiRes = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: message }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("✅ Using OpenAI");
    return openaiRes.data.choices[0].message.content;

  } catch (err) {
    console.log("⚠️ OpenAI failed. Trying Grok...");

    try {
      const grokRes = await axios.post(
        "https://api.x.ai/v1/chat/completions",
        {
          model: "grok-2-latest",
          messages: [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: message }
          ]
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.XAI_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );
      console.log("✅ Using Grok (xAI)");
      return grokRes.data.choices[0].message.content;

    } catch (err2) {
      console.error("❌ Both AI providers failed.");
      return "AI service temporarily unavailable. Please try again later.";
    }
  }
}

// ------------------------------
// M-Pesa STK Push
// ------------------------------
async function stkPush(phoneNumber, subscriptionType) {
  const amount = subscriptionType === "normal" ? 150 : 300;
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);

  const shortCode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const password = Buffer.from(shortCode + passkey + timestamp).toString("base64");

  try {
    const tokenRes = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      {
        auth: {
          username: process.env.MPESA_CONSUMER_KEY,
          password: process.env.MPESA_CONSUMER_SECRET
        }
      }
    );

    const accessToken = tokenRes.data.access_token;

    await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phoneNumber,
        PartyB: shortCode,
        PhoneNumber: phoneNumber,
        CallBackURL: process.env.MPESA_CALLBACK_URL,
        AccountReference: subscriptionType,
        TransactionDesc: `${subscriptionType} Subscription`
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    return true;

  } catch (err) {
    console.error("M-Pesa Error:", err.response?.data || err.message);
    return false;
  }
}

// ------------------------------
// M-Pesa Callback
// ------------------------------
app.post("/mpesa-callback", (req, res) => {
  try {
    const metadata = req.body?.Body?.stkCallback?.CallbackMetadata?.Item;
    if (!metadata) return res.sendStatus(200);

    const phone = metadata.find(i => i.Name === "PhoneNumber")?.Value;
    const amount = metadata.find(i => i.Name === "Amount")?.Value;
    const accountType = req.body?.Body?.stkCallback?.AccountReference;

    if (phone && accountType) {
      const key = `whatsapp:${phone}`;
      const t = today();
      let user = users[key] || {};

      if (accountType === "normal") {
        user.subscription = "normal";
        user.normal = { purchaseDate: t };
      }

      if (accountType === "premium") {
        user.subscription = "premium";
        user.premium = { purchaseDate: t };
        user.normal = { purchaseDate: t }; // Premium includes normal
      }

      users[key] = user;
      saveUsers();

      // Notify admin
      client.messages.create({
        from: `whatsapp:${twilioNumber}`,
        to: `whatsapp:${adminNumber}`,
        body: `💰 Payment received from ${phone} - Ksh ${amount} - ${accountType}`
      });
    }

  } catch (err) {
    console.error("Callback Error:", err.message);
  }

  res.sendStatus(200);
});

// ------------------------------
// WhatsApp Webhook
// ------------------------------
app.post("/whatsapp", async (req, res) => {
  const msg = req.body.Body?.toLowerCase().trim() || "";
  const from = req.body.From;

  if (!users[from]) {
    users[from] = { subscription: "free", rulesAccepted: false };
  }

  let user = users[from];

  // ------------------------------
  // RULES ACCEPTANCE
  // ------------------------------
  if (!user.rulesAccepted) {
    if (msg === "accept") {
      user.rulesAccepted = true;
      saveUsers();
      await client.messages.create({
        from: `whatsapp:${twilioNumber}`,
        to: from,
        body: "✅ Thank you! You may now use the bot. Type 'menu' to see commands."
      });
    } else {
      await client.messages.create({
        from: `whatsapp:${twilioNumber}`,
        to: from,
        body: "⚠️ Before using the bot, you must accept the rules. Type 'accept' to proceed."
      });
    }
    return res.sendStatus(200);
  }

  // 🔥 AUTO EXPIRY CHECK
  if (user.subscription === "normal" && isExpired(user.normal?.purchaseDate)) {
    user.subscription = "free";
  }
  if (user.subscription === "premium" && isExpired(user.premium?.purchaseDate)) {
    user.subscription = "free";
  }

  // ------------------------------
  // Fixed Prompt Logic
  // ------------------------------
  let reply = "";

  if (msg === "todays safe tips") {
    reply = "🟢 Free User: Here is today's safe tip...";
    reply += "\n\nUpgrade to Normal or Premium for better analyzed matches.";

  } else if (msg === "todays paid tips") {
    if (user.subscription === "normal" || user.subscription === "premium") {
      reply = "🟡 Normal Paid Tips: Here is today's paid slip...";
    } else {
      reply = "To access paid tips, please subscribe to Normal (Ksh 150/week).";
    }

  } else if (msg === "todays premium tips") {
    if (user.subscription === "premium") {
      reply = "🔵 Premium Tips: Here are today's premium slips...";
    } else {
      reply = "Premium tips require Premium subscription (Ksh 300/week).";
    }

  } else if (msg.includes("subscribe")) {
    const type = msg.includes("normal") ? "normal" : "premium";
    const success = await stkPush(from.replace("whatsapp:", ""), type);

    reply = success
      ? `💳 ${type.toUpperCase()} subscription initiated. Complete payment on your phone.`
      : "Payment request failed. Try again.";

  } else if (msg === "menu") {
    reply = "📋 Commands:\n- todays safe tips (Free)\n- todays paid tips (Normal)\n- todays premium tips (Premium)\n- subscribe normal\n- subscribe premium";

  } else {
    // Fallback AI response
    reply = await getAIResponse(req.body.Body);
  }

  users[from] = user;
  saveUsers();

  await client.messages.create({
    from: `whatsapp:${twilioNumber}`,
    to: from,
    body: reply
  });

  res.sendStatus(200);
});

// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Dennis AI Bot running on port ${PORT}`)
);
