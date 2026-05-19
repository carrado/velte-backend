export const sendSms = async (to, message) => {
  const payload = {
    to,
    from: process.env.TERMII_SENDER_ID,
    sms: message,
    type: "plain",
    api_key: process.env.TERMII_API_KEY,
    channel: "generic",
  };

  const response = await fetch("https://api.ng.termii.com/api/sms/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Termii error: ${data.message || "SMS delivery failed"}`);
  }

  return data;
};
